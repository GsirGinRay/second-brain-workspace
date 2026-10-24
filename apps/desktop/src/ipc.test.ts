import assert from "node:assert/strict";
import test from "node:test";
import {
  createNativeAdapter,
  validateAppUpdateCheck,
  type NativeInvoke,
} from "./ipc";

test("IPC adapter rejects private-key-shaped native responses", async () => {
  const invoke: NativeInvoke = async (command) => {
    if (command === "diagnostics") return { ...{
        selectedVault: null,
        watcherStatus: "stopped",
        keyFingerprint: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        keyBackend: "test-memory-v1",
        recoveryStatus: "none",
        closeBehavior: "exit",
        autostartEnabled: false,
      }, privateKey: "must-never-cross-ipc" };
    throw new Error(`unexpected command ${command}`);
  };

  await assert.rejects(
    () => createNativeAdapter(invoke).getDiagnostics(),
    /private|secret|unknown/i,
  );
});

test("non-Web fake adapter can be injected without DOM or transport assumptions", async () => {
  const adapter = createNativeAdapter(async (command) => {
    if (command === "diagnostics") return {
      selectedVault: null,
      watcherStatus: "stopped",
      keyFingerprint: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      keyBackend: "test-memory-v1",
      recoveryStatus: "none",
      closeBehavior: "exit",
      autostartEnabled: false,
    };
    throw new Error("unexpected command");
  });

  assert.equal((await adapter.getDiagnostics()).keyBackend, "test-memory-v1");
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

test("attachment IPC rejects escape paths and keeps markdown writes on .md files", async () => {
  const adapter = createNativeAdapter(async (command) => {
    if (command === "import_vault_attachment") return { relativePath: "附件/專案/a.png" };
    if (command === "read_vault_attachment") {
      return { relativePath: "附件/專案/a.png", mimeType: "image/png", bytesBase64: "YQ==" };
    }
    return undefined;
  });
  assert.equal(
    (await adapter.importVaultAttachment!({
      folder: "專案",
      fileName: "a.png",
      bytesBase64: "YQ==",
    })).relativePath,
    "附件/專案/a.png",
  );
  await assert.rejects(
    () => adapter.importVaultAttachment!({ folder: "../x", fileName: "a.png", bytesBase64: "YQ==" }),
    /folder/i,
  );
  await assert.rejects(
    () => adapter.importVaultAttachment!({ folder: "專案", fileName: "a.exe", bytesBase64: "YQ==" }),
    /file name/i,
  );
  await assert.rejects(() => adapter.openVaultAttachment!("專案/a.png"), /attachment path/i);
  await assert.rejects(() => adapter.openVaultAttachment!("附件/../a.png"), /attachment path/i);
  const pdfPreview = createNativeAdapter(async () => ({
    relativePath: "附件/專案/a.png",
    mimeType: "application/pdf",
    bytesBase64: "YQ==",
  }));
  await assert.rejects(() => pdfPreview.readVaultAttachment!("附件/專案/a.png"), /mime/i);
});

test("update IPC validates the signed-updater status contract", async () => {
  const status = validateAppUpdateCheck({
    currentVersion: "0.5.1",
    latestVersion: "0.6.0",
    available: true,
    checked: true,
    notes: "自動儲存與返回上一頁",
  });
  assert.equal(status.available, true);
  assert.equal(status.notes, "自動儲存與返回上一頁");

  assert.throws(
    () => validateAppUpdateCheck({
      currentVersion: "0.5.1",
      latestVersion: "0.6.0",
      available: true,
      checked: true,
      notes: null,
      installerUrl: "https://evil.example/update.exe",
    }),
    /unknown|installerUrl/i,
  );
  assert.throws(
    () => validateAppUpdateCheck({
      currentVersion: "0.5.1",
      latestVersion: "latest",
      available: true,
      checked: true,
      notes: null,
    }),
    /version/i,
  );

  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const adapter = createNativeAdapter(async (command, args) => {
    calls.push([command, args]);
    if (command === "check_app_update") {
      return { currentVersion: "0.5.1", latestVersion: "0.5.1", available: false, checked: true, notes: null };
    }
    return undefined;
  });
  assert.equal((await adapter.checkAppUpdate!()).available, false);
  await adapter.installAppUpdate!();
  assert.deepEqual(calls.at(-1), ["install_app_update", undefined], "the renderer never chooses the download URL");
});
