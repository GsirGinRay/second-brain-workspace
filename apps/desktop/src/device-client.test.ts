import assert from "node:assert/strict";
import test from "node:test";
import { DeviceClient, PublisherHttpError, normalizeServerOrigin } from "./device-client";
import type { NativeAdapter } from "./ipc";

function native(): NativeAdapter {
  return {
    async getDeviceIdentity() { return { deviceId: "11111111-1111-4111-8111-111111111111", publicKeyBase64Url: "A".repeat(43), fingerprint: `sha256:${"0".repeat(64)}`, backend: "test" }; },
    async completeDevicePairing() {},
    async signCanonicalRequest(request) {
      assert.equal(request.method, "GET");
      assert.equal(request.path, "/api/brain/device/state");
      assert.equal(request.bodySha256, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
      return { signatureBase64Url: "A".repeat(86) };
    },
    async publisherHttpRequest() { throw new Error("unused"); },
    async openPublisherPairing() {},
    async getDiagnostics() { throw new Error("unused"); }, async pickVaultFolder() { return null; }, async selectVault() { throw new Error("unused"); },
    async setAutostart() {}, async setCloseBehavior() {}, async scanVault() { return []; },
    async readMarkdownFiles() { return []; }, async applyMarkdownChanges() { throw new Error("unused"); },
    async confirmServerCommit() {},
    async savePendingCommit() {}, async loadPendingCommit() { return null; }, async clearPendingCommit() {},
    async pendingJournals() { return []; },
  };
}

test("server origin requires HTTPS except loopback development", () => {
  assert.equal(normalizeServerOrigin("http://localhost:3000"), "http://localhost:3000");
  assert.throws(() => normalizeServerOrigin("http://brain.example.com"), /HTTPS/);
  assert.equal(normalizeServerOrigin("https://brain.example.com"), "https://brain.example.com");
  assert.throws(() => normalizeServerOrigin("https://user:pass@example.com"), /credentials/);
});

test("signed client delegates signing and transport to native IPC", async () => {
  let captured: unknown;
  const adapter = native();
  adapter.publisherHttpRequest = async (request) => {
    captured = request;
    return { status: 200, headers: { etag: '"brain-2"' }, body: JSON.stringify({ revision: 2, pendingCount: 0, lastSyncAt: null }) };
  };
  const client = new DeviceClient("http://localhost:3000", adapter);
  const result = await client.getState(null);
  assert.equal(result.kind, "modified");
  assert.deepEqual(captured, {
    origin: "http://localhost:3000",
    method: "GET",
    path: "/api/brain/device/state",
    body: null,
    headers: {},
    signed: true,
  });
  assert.doesNotMatch(JSON.stringify(captured), /private|signature|secret/i);
});

test("pairing uses unsigned native HTTP and opens the allowlisted native page", async () => {
  const adapter = native();
  let opened = "";
  adapter.publisherHttpRequest = async (request) => {
    assert.equal(request.signed, false);
    assert.equal(request.path, "/api/brain/device/pair/start");
    return { status: 201, headers: {}, body: JSON.stringify({
      pairingId: "22222222-2222-4222-8222-222222222222",
      pollingSecret: "secret",
      userCode: "ABCDEFGH",
      expiresAt: "2026-08-12T12:00:00.000Z",
    }) };
  };
  adapter.openPublisherPairing = async (origin, pairingId) => { opened = `${origin}/${pairingId}`; };
  const client = new DeviceClient("http://localhost:3000", adapter);
  const result = await client.startPairing("Second Brain Workspace");
  await client.openPairingPage(result.pairingId);
  assert.equal(result.userCode, "ABCDEFGH");
  assert.equal(opened, "http://localhost:3000/22222222-2222-4222-8222-222222222222");
});

test("permanent task deletion is owner-bound through a signed native request", async () => {
  let captured: unknown;
  const signingNative = native();
  signingNative.publisherHttpRequest = async (request) => { captured = request; return { status: 204, headers: {}, body: "" }; };
  const client = new DeviceClient("http://localhost:3000", signingNative);
  await client.deleteTaskPermanently("33333333-3333-4333-8333-333333333333");
  assert.deepEqual(captured, {
    origin: "http://localhost:3000", method: "DELETE",
    path: "/api/brain/device/tasks/33333333-3333-4333-8333-333333333333",
    body: null, headers: {}, signed: true,
  });
});

test("permanent project deletion uses a signed project endpoint", async () => {
  let captured: unknown;
  const signingNative = native();
  signingNative.publisherHttpRequest = async (request) => { captured = request; return { status: 204, headers: {}, body: "" }; };
  const client = new DeviceClient("http://localhost:3000", signingNative);
  await client.deleteProjectPermanently("44444444-4444-4444-8444-444444444444");
  assert.deepEqual(captured, {
    origin: "http://localhost:3000", method: "DELETE",
    path: "/api/brain/device/projects/44444444-4444-4444-8444-444444444444",
    body: null, headers: {}, signed: true,
  });
});

test("HTTP failures preserve status, server error code, and readable detail", async () => {
  const adapter = native();
  adapter.publisherHttpRequest = async () => ({
    status: 401,
    headers: {},
    body: JSON.stringify({ error: { code: "DEVICE_SIGNATURE_INVALID", message: "Device signature was rejected" } }),
  });
  const client = new DeviceClient("https://brain.example.com", adapter);
  await assert.rejects(
    () => client.getState(null),
    (error: unknown) => error instanceof PublisherHttpError
      && error.status === 401
      && error.code === "DEVICE_SIGNATURE_INVALID"
      && /HTTP 401/.test(error.message),
  );
});

test("sync plan request contains structured fields but no Markdown body or attachment", async () => {
  const adapter = native();
  let body = "";
  adapter.publisherHttpRequest = async (request) => {
    body = request.body ?? "";
    return { status: 200, headers: {}, body: JSON.stringify({ planId: "22222222-2222-4222-8222-222222222222", baseRevision: 0, targetRevision: 1, payloadDigest: "b".repeat(64), expiresAt: "2026-08-13T00:00:00.000Z", desiredTasks: [], desiredProjects: [], conflicts: [] }) };
  };
  await new DeviceClient("https://brain.example.com", adapter).createPlan({
    schemaVersion: 3, baseRevision: 0,
    tasks: [{ id: "11111111-1111-4111-8111-111111111111", title: "Task", status: "todo", taskDate: null, priority: "normal", projectId: null, projectName: null, rank: "a", sourcePath: "notes.md", sourceHeading: null, completedAt: null, body: "private task Markdown" }],
    projects: [{ id: "22222222-2222-4222-8222-222222222222", name: "Project", sourcePath: "project.md", status: "active", area: null, priority: null, progress: 0, focusToday: false, body: "private project Markdown" }],
    fileHashes: { "notes.md": "a".repeat(64) },
  });
  assert.match(body, /fileHashes/);
  assert.match(body, /"title":"Task"/);
  assert.doesNotMatch(body, /private task Markdown|private project Markdown/);
  assert.doesNotMatch(body, /bytesBase64|replacementBase64|markdownBody|attachment|privateKey/i);
});

test("sync commit carries plan choices and idempotency through signed native HTTP", async () => {
  const adapter = native();
  let captured: Parameters<NativeAdapter["publisherHttpRequest"]>[0] | undefined;
  adapter.publisherHttpRequest = async (request) => {
    captured = request;
    return { status: 200, headers: {}, body: JSON.stringify({ ok: true }) };
  };
  const idempotencyKey = "44444444-4444-4444-8444-444444444444";
  await new DeviceClient("https://brain.example.com", adapter).commitPlan(
    "22222222-2222-4222-8222-222222222222",
    [],
    idempotencyKey,
  );
  assert.equal(captured?.path, "/api/brain/device/sync/commit");
  assert.equal(captured?.signed, true);
  assert.equal(captured?.headers["idempotency-key"], idempotencyKey);
  assert.match(captured?.body ?? "", /22222222-2222-4222-8222-222222222222/);
});

test("routine template sync uses signed structured requests without Markdown content", async () => {
  const adapter = native();
  const requests: Array<Parameters<NativeAdapter["publisherHttpRequest"]>[0]> = [];
  const template = {
    id: "55555555-5555-4555-8555-555555555555",
    name: "Daily startup",
    version: 1,
    updatedAt: "2026-08-14T00:00:00.000Z",
    items: [{
      id: "66666666-6666-4666-8666-666666666666",
      title: "Review today's schedule",
      enabled: true,
      projectId: null,
      projectName: null,
      priority: "normal" as const,
      startTime: "10:00",
      durationMinutes: 30,
      rank: "00000000",
    }],
  };
  adapter.publisherHttpRequest = async (request) => {
    requests.push(request);
    return { status: 200, headers: {}, body: JSON.stringify(template) };
  };
  const client = new DeviceClient("https://brain.example.com", adapter);
  assert.deepEqual(await client.getRoutineTemplate(), template);
  assert.deepEqual(await client.saveRoutineTemplate(template), template);
  assert.deepEqual(requests.map(({ method, path, signed }) => ({ method, path, signed })), [
    { method: "GET", path: "/api/brain/device/routine-template", signed: true },
    { method: "POST", path: "/api/brain/device/routine-template", signed: true },
  ]);
  assert.doesNotMatch(JSON.stringify(requests), /markdownBody|attachment|absolutePath|privateKey/i);
});
