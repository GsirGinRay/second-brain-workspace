import assert from "node:assert/strict";
import test from "node:test";
import {
  createNativeAdapter,
  validateDeviceIdentity,
  validateSignResponse,
  type NativeInvoke,
} from "./ipc";

test("IPC identity exposes only public identity fields", () => {
  const identity = validateDeviceIdentity({
    deviceId: "device-1",
    publicKeyBase64Url: "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg",
    fingerprint: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    backend: "windows-dpapi-v1",
  });

  assert.deepEqual(Object.keys(identity).sort(), [
    "backend",
    "deviceId",
    "fingerprint",
    "publicKeyBase64Url",
  ]);
  assert.equal("privateKey" in identity, false);
  assert.equal("secret" in identity, false);
});

test("IPC adapter rejects private-key-shaped native responses", async () => {
  const invoke: NativeInvoke = async (command) => {
    if (command === "device_identity") {
      return {
        deviceId: "device-1",
        publicKeyBase64Url: "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg",
        fingerprint: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        backend: "windows-dpapi-v1",
        privateKey: "must-never-cross-ipc",
      };
    }
    throw new Error(`unexpected command ${command}`);
  };

  await assert.rejects(
    () => createNativeAdapter(invoke).getDeviceIdentity(),
    /private|secret|unknown/i,
  );
});

test("IPC sign response validates a base64url signature and no key material", () => {
  const signature = "A".repeat(86);
  const response = validateSignResponse({ signatureBase64Url: signature });
  assert.deepEqual(response, { signatureBase64Url: signature });
  assert.throws(
    () => validateSignResponse({ signatureBase64Url: `${signature}=`, privateKey: "x" }),
    /private|secret|signature/i,
  );
});

test("non-Web fake adapter can be injected without DOM or transport assumptions", async () => {
  const adapter = createNativeAdapter(async (command) => {
    if (command === "device_identity") {
      return {
        deviceId: "device-1",
        publicKeyBase64Url: "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg",
        fingerprint: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        backend: "test-memory-v1",
      };
    }
    if (command === "sign_canonical_request") return { signatureBase64Url: "A".repeat(86) };
    throw new Error("unexpected command");
  });

  assert.equal((await adapter.getDeviceIdentity()).deviceId, "device-1");
  assert.equal(
    (await adapter.signCanonicalRequest({
      method: "GET",
      path: "/api/brain/device/state",
      query: [],
      timestamp: 1_786_416_000,
      nonce: "AAECAwQFBgcICQoLDA0ODw",
      contentType: "",
      bodySha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    })).signatureBase64Url,
    "A".repeat(86),
  );
});

test("close behavior is an explicit validated native setting", async () => {
  const commands: string[] = [];
  const adapter = createNativeAdapter(async (command) => {
    commands.push(command);
    return undefined;
  });
  await adapter.setCloseBehavior("hide_to_tray");
  assert.deepEqual(commands, ["set_close_behavior"]);
  await assert.rejects(
    () => adapter.setCloseBehavior("unexpected" as never),
    /close behavior/i,
  );
});

test("pairing completion persists the server-issued device id through native IPC", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const adapter = createNativeAdapter(async (command, args) => {
    calls.push({ command, args });
    return undefined;
  });
  const deviceId = "11111111-1111-4111-8111-111111111111";

  await adapter.completeDevicePairing(deviceId);

  assert.deepEqual(calls, [{ command: "complete_device_pairing", args: { deviceId } }]);
  await assert.rejects(() => adapter.completeDevicePairing("not-a-uuid"), /device id/i);
});

test("vault browser returns only a selected local folder path", async () => {
  const commands: string[] = [];
  const adapter = createNativeAdapter(async (command) => {
    commands.push(command);
    return command === "pick_vault_folder" ? "C:\\Users\\name\\Documents\\SecondBrain" : undefined;
  });
  assert.equal(await adapter.pickVaultFolder(), "C:\\Users\\name\\Documents\\SecondBrain");
  assert.deepEqual(commands, ["pick_vault_folder"]);

  const cancelled = createNativeAdapter(async () => null);
  assert.equal(await cancelled.pickVaultFolder(), null);
  const malformed = createNativeAdapter(async () => ({ path: "secret" }));
  await assert.rejects(() => malformed.pickVaultFolder(), /folder path/i);
});

test("markdown IPC validates exact structured responses and never accepts note body fields", async () => {
  const adapter = createNativeAdapter(async (command) => {
    if (command === "scan_vault") return {
      files: [{ relativePath: "tasks.md", sha256: "a".repeat(64), bytes: 10, hasBom: false, newline: "cr_lf" }],
      totalBytes: 10,
    };
    if (command === "read_markdown_files") return {
      files: [{ relativePath: "tasks.md", sha256: "a".repeat(64), bytesBase64: "YQ==" }],
    };
    throw new Error(`unexpected command ${command}`);
  });
  assert.equal((await adapter.scanVault())[0]?.relativePath, "tasks.md");
  assert.equal((await adapter.readMarkdownFiles(["tasks.md"]))[0]?.bytesBase64, "YQ==");

  const unsafe = createNativeAdapter(async () => ({
    files: [{ relativePath: "tasks.md", sha256: "a".repeat(64), bytesBase64: "YQ==", noteBody: "secret" }],
  }));
  await assert.rejects(() => unsafe.readMarkdownFiles(["tasks.md"]), /unknown|secret/i);
});

test("pending commit IPC rejects malformed nested choices and journal paths", async () => {
  const malformedChoice = createNativeAdapter(async () => ({
    planId: "2cf0c566-a02e-4a0a-bdbc-7d1f8686db24",
    idempotencyKey: "f34ba878-b183-41b4-bca2-85c6ea90ce5c",
    choices: [{ entity: "task", id: "task-1", field: "title", choice: "local", secret: "x" }],
    journalPaths: ["C:\\SecondBrain\\recovery\\batch.journal.json"],
  }));
  await assert.rejects(() => malformedChoice.loadPendingCommit(), /pending commit|unknown|secret/i);

  const malformedJournal = createNativeAdapter(async () => ({
    planId: "2cf0c566-a02e-4a0a-bdbc-7d1f8686db24",
    idempotencyKey: "f34ba878-b183-41b4-bca2-85c6ea90ce5c",
    choices: [],
    journalPaths: ["C:\\SecondBrain\\recovery\\not-a-journal.txt"],
  }));
  await assert.rejects(() => malformedJournal.loadPendingCommit(), /pending commit/i);
});
