import assert from "node:assert/strict";
import test from "node:test";
import { DeviceClient, normalizeServerOrigin } from "./device-client";
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
  assert.throws(() => normalizeServerOrigin("https://brain.example.com"), /not configured/);
  assert.throws(() => normalizeServerOrigin("https://user:pass@example.com"), /credentials/);
});

test("signed client binds request headers and never exposes private key material", async () => {
  let captured: RequestInit | undefined;
  const client = new DeviceClient("http://localhost:3000", native(), async (_url, init) => {
    captured = init;
    return new Response(JSON.stringify({ revision: 2, pendingCount: 0, lastSyncAt: null }), {
      status: 200,
      headers: { "content-type": "application/json", etag: '"brain-2"' },
    });
  });
  const result = await client.getState(null);
  assert.equal(result.kind, "modified");
  const headers = new Headers(captured?.headers);
  assert.equal(headers.get("x-brain-device-id"), "11111111-1111-4111-8111-111111111111");
  assert.equal(headers.get("x-brain-signature"), "A".repeat(86));
  assert.equal(headers.has("private-key"), false);
});

test("default fetcher preserves the browser global receiver", async () => {
  const originalFetch = globalThis.fetch;
  let receiverWasGlobal = false;
  globalThis.fetch = async function (this: typeof globalThis, _input, _init) {
    receiverWasGlobal = this === globalThis;
    if (!receiverWasGlobal) throw new TypeError("Illegal invocation");
    return new Response(JSON.stringify({
      pairingId: "22222222-2222-4222-8222-222222222222",
      pollingSecret: "secret",
      userCode: "ABCDEFGH",
      expiresAt: "2026-08-12T12:00:00.000Z",
    }), { status: 201, headers: { "content-type": "application/json" } });
  } as typeof fetch;

  try {
    const client = new DeviceClient("http://localhost:3000", native());
    const result = await client.startPairing("Second Brain Workspace");
    assert.equal(result.userCode, "ABCDEFGH");
    assert.equal(receiverWasGlobal, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("permanent task deletion is owner-bound through a signed DELETE request", async () => {
  let capturedUrl = "";
  let captured: RequestInit | undefined;
  const signingNative = native();
  signingNative.signCanonicalRequest = async (request) => {
    assert.equal(request.method, "DELETE");
    assert.equal(request.path, "/api/brain/device/tasks/33333333-3333-4333-8333-333333333333");
    return { signatureBase64Url: "A".repeat(86) };
  };
  const client = new DeviceClient("http://localhost:3000", signingNative, async (url, init) => {
    capturedUrl = String(url);
    captured = init;
    return new Response(null, { status: 204 });
  });
  await client.deleteTaskPermanently("33333333-3333-4333-8333-333333333333");
  assert.equal(capturedUrl, "http://localhost:3000/api/brain/device/tasks/33333333-3333-4333-8333-333333333333");
  assert.equal(captured?.method, "DELETE");
  assert.equal(captured?.body, undefined);
});
