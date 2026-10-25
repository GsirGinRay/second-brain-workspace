import {
  RoutineTemplateSchema,
  type RoutineTemplate,
} from "@second-brain/brain-core";
import {
  validateInboxRelayEntitlement,
  validateInboxRelayItems,
  validateInboxRelayPairing,
  validateInboxRelayStatus,
  type InboxRelayApi,
} from "./inbox-relay";

export interface DiagnosticsSnapshot {
  selectedVault: string | null;
  watcherStatus: string;
  keyFingerprint: string;
  keyBackend: string;
  recoveryStatus: string;
  closeBehavior: "hide_to_tray" | "exit";
  autostartEnabled: boolean;
}

export interface ScannedMarkdownFile {
  relativePath: string;
  sha256: string;
  bytes: number;
  hasBom: boolean;
  newline: "cr_lf" | "lf" | "mixed" | "none";
}

export interface MarkdownFileContents {
  relativePath: string;
  sha256: string;
  bytesBase64: string;
}

export type MarkdownChangeRequest = {
  relativePath: string;
  expectedSha256: string;
  replacementBase64: string;
  operation?: "write";
} | {
  relativePath: string;
  expectedSha256: string;
  replacementBase64: string;
  operation: "create";
} | {
  relativePath: string;
  expectedSha256: string;
  operation: "delete";
  replacementBase64: "";
};

export interface MarkdownApplyResult {
  journalPath: string;
  backupPath: string;
}

export interface ImportVaultAttachmentRequest {
  folder: string;
  fileName: string;
  bytesBase64: string;
}

export interface VaultAttachmentInfo {
  relativePath: string;
}

export interface VaultAttachmentContents {
  relativePath: string;
  mimeType: string;
  bytesBase64: string;
}

export type NativeInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface AppUpdateCheck {
  currentVersion: string;
  latestVersion: string;
  available: boolean;
  checked: boolean;
  notes: string | null;
}

export interface NativeAdapter {
  getDiagnostics(): Promise<DiagnosticsSnapshot>;
  pickVaultFolder(): Promise<string | null>;
  selectVault(path: string): Promise<{ vaultId: string; root: string }>;
  setAutostart(enabled: boolean): Promise<void>;
  setCloseBehavior(behavior: DiagnosticsSnapshot["closeBehavior"]): Promise<void>;
  scanVault(): Promise<ScannedMarkdownFile[]>;
  readMarkdownFiles(relativePaths: string[]): Promise<MarkdownFileContents[]>;
  listManagedFiles?(folder: string): Promise<string[]>;
  importVaultAttachment?(request: ImportVaultAttachmentRequest): Promise<VaultAttachmentInfo>;
  readVaultAttachment?(relativePath: string): Promise<VaultAttachmentContents>;
  openVaultAttachment?(relativePath: string): Promise<void>;
  applyMarkdownChanges(changes: MarkdownChangeRequest[]): Promise<MarkdownApplyResult>;
  loadRoutineTemplate?(): Promise<RoutineTemplate | null>;
  saveRoutineTemplate?(template: RoutineTemplate): Promise<void>;
  checkAppUpdate?(): Promise<AppUpdateCheck>;
  installAppUpdate?(): Promise<void>;
  showReminder?(title: string, body: string): Promise<void>;
  inboxRelay?: InboxRelayApi;
}

function assertRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("native response must be an object");
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`native response contains unknown or secret field: ${key}`);
  }
}

function assertString(value: unknown, name: string, maxLength = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`native response field ${name} is invalid`);
  }
  return value;
}

function assertSha256(value: unknown, name: string): string {
  const result = assertString(value, name, 64);
  if (!/^[a-f0-9]{64}$/i.test(result)) throw new Error(`native response field ${name} is invalid`);
  return result.toLowerCase();
}

const ATTACHMENT_EXT = /\.(png|jpe?g|gif|webp|svg|pdf|txt|md|csv)$/i;

function assertAttachmentFolder(value: string): string {
  if (
    value.length === 0
    || value.length > 100
    || value.includes("..")
    || value.includes("/")
    || value.includes("\\")
    || value.startsWith(".")
  ) {
    throw new Error("attachment folder is invalid");
  }
  return value;
}

function assertAttachmentFileName(value: string): string {
  if (
    value.length === 0
    || value.length > 200
    || value.includes("..")
    || value.includes("/")
    || value.includes("\\")
    || value.startsWith(".")
    || !ATTACHMENT_EXT.test(value)
  ) {
    throw new Error("attachment file name is invalid");
  }
  return value;
}

function assertAttachmentRelativePath(value: unknown): string {
  const path = assertString(value, "relativePath", 500);
  if (
    path.includes("..")
    || path.startsWith("/")
    || path.includes("\\")
    || !ATTACHMENT_EXT.test(path)
  ) {
    throw new Error("attachment path is invalid");
  }
  const parts = path.split("/").filter(Boolean);
  // 附件/ in Chinese vaults, Attachments/ in English ones.
  if (parts.length !== 3 || (parts[0] !== "附件" && parts[0] !== "Attachments")) throw new Error("attachment path is invalid");
  return path;
}

function validateDiagnostics(value: unknown): DiagnosticsSnapshot {
  const record = assertRecord(value);
  assertExactKeys(record, [
    "selectedVault",
    "watcherStatus",
    "keyFingerprint",
    "keyBackend",
    "recoveryStatus",
    "closeBehavior",
    "autostartEnabled",
  ]);
  const selectedVault = record.selectedVault;
  if (selectedVault !== null && typeof selectedVault !== "string") {
    throw new Error("native diagnostics vault is invalid");
  }
  return {
    selectedVault,
    watcherStatus: assertString(record.watcherStatus, "watcherStatus"),
    keyFingerprint: assertString(record.keyFingerprint, "keyFingerprint"),
    keyBackend: assertString(record.keyBackend, "keyBackend"),
    recoveryStatus: assertString(record.recoveryStatus, "recoveryStatus"),
    closeBehavior: record.closeBehavior === "hide_to_tray" ? "hide_to_tray" : "exit",
    autostartEnabled: record.autostartEnabled === true,
  };
}

export function validateAppUpdateCheck(value: unknown): AppUpdateCheck {
  const record = assertRecord(value);
  assertExactKeys(record, ["currentVersion", "latestVersion", "available", "checked", "notes"]);
  if (typeof record.available !== "boolean" || typeof record.checked !== "boolean") {
    throw new Error("native update status is invalid");
  }
  const currentVersion = assertString(record.currentVersion, "currentVersion", 32);
  const latestVersion = assertString(record.latestVersion, "latestVersion", 32);
  if (!/^\d+\.\d+\.\d+$/.test(currentVersion) || !/^\d+\.\d+\.\d+$/.test(latestVersion)) {
    throw new Error("native update version is invalid");
  }
  return {
    currentVersion,
    latestVersion,
    available: record.available,
    checked: record.checked,
    notes: record.notes === null || record.notes === undefined ? null : assertString(record.notes, "notes", 4000),
  };
}

async function defaultInvoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
  const module = await import("@tauri-apps/api/core");
  return module.invoke(command, args);
}

export function createNativeAdapter(invoke: NativeInvoke = defaultInvoke): NativeAdapter {
  return {
    async getDiagnostics() {
      return validateDiagnostics(await invoke("diagnostics"));
    },
    async loadRoutineTemplate() {
      const value = await invoke("load_routine_template");
      if (value === null) return null;
      return RoutineTemplateSchema.parse(value);
    },
    async saveRoutineTemplate(template) {
      await invoke("save_routine_template", { template: RoutineTemplateSchema.parse(template) });
    },
    async pickVaultFolder() {
      const value = await invoke("pick_vault_folder");
      if (value === null) return null;
      if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
        throw new Error("native folder path is invalid");
      }
      return value;
    },
    async selectVault(path) {
      if (path.trim() === "") throw new Error("vault path is required");
      const value = assertRecord(await invoke("select_vault", { path }));
      assertExactKeys(value, ["vaultId", "root"]);
      return {
        vaultId: assertString(value.vaultId, "vaultId", 128),
        root: assertString(value.root, "root", 4096),
      };
    },
    async setAutostart(enabled) {
      await invoke("set_autostart_command", { enabled });
    },
    async setCloseBehavior(behavior) {
      if (behavior !== "exit" && behavior !== "hide_to_tray") {
        throw new Error("native close behavior is invalid");
      }
      await invoke("set_close_behavior", { behavior });
    },
    async scanVault() {
      const value = assertRecord(await invoke("scan_vault"));
      assertExactKeys(value, ["files", "totalBytes"]);
      if (!Array.isArray(value.files)) throw new Error("native scan files are invalid");
      return value.files.map((item) => {
        const file = assertRecord(item);
        assertExactKeys(file, ["relativePath", "sha256", "bytes", "hasBom", "newline"]);
        if (typeof file.bytes !== "number" || !Number.isSafeInteger(file.bytes) || file.bytes < 0) {
          throw new Error("native scan byte count is invalid");
        }
        if (!['cr_lf', 'lf', 'mixed', 'none'].includes(String(file.newline))) {
          throw new Error("native newline style is invalid");
        }
        return {
          relativePath: assertString(file.relativePath, "relativePath", 500),
          sha256: assertSha256(file.sha256, "sha256"),
          bytes: file.bytes,
          hasBom: file.hasBom === true,
          newline: file.newline as ScannedMarkdownFile["newline"],
        };
      });
    },
    async readMarkdownFiles(relativePaths) {
      if (relativePaths.length === 0) return [];
      const value = assertRecord(await invoke("read_markdown_files", { request: { relativePaths } }));
      assertExactKeys(value, ["files"]);
      if (!Array.isArray(value.files)) throw new Error("native markdown files are invalid");
      return value.files.map((item) => {
        const file = assertRecord(item);
        assertExactKeys(file, ["relativePath", "sha256", "bytesBase64"]);
        const bytesBase64 = assertString(file.bytesBase64, "bytesBase64", 24_000_000);
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(bytesBase64)) throw new Error("native markdown bytes are invalid");
        return {
          relativePath: assertString(file.relativePath, "relativePath", 500),
          sha256: assertSha256(file.sha256, "sha256"),
          bytesBase64,
        };
      });
    },
    async listManagedFiles(folder) {
      const value = await invoke("list_managed_files", { folder });
      if (!Array.isArray(value)) throw new Error("native managed file list is invalid");
      return value.map((item) => assertString(item, "path", 500));
    },
    async importVaultAttachment(request) {
      assertAttachmentFolder(request.folder);
      assertAttachmentFileName(request.fileName);
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(request.bytesBase64) || request.bytesBase64.length > 24_000_000) {
        throw new Error("attachment bytes are invalid");
      }
      const value = assertRecord(await invoke("import_vault_attachment", { request }));
      assertExactKeys(value, ["relativePath"]);
      return { relativePath: assertAttachmentRelativePath(value.relativePath) };
    },
    async readVaultAttachment(relativePath) {
      const path = assertAttachmentRelativePath(relativePath);
      const value = assertRecord(await invoke("read_vault_attachment", { request: { relativePath: path } }));
      assertExactKeys(value, ["relativePath", "mimeType", "bytesBase64"]);
      const bytesBase64 = assertString(value.bytesBase64, "bytesBase64", 24_000_000);
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(bytesBase64)) throw new Error("native attachment bytes are invalid");
      const mimeType = assertString(value.mimeType, "mimeType", 128);
      if (!mimeType.startsWith("image/")) throw new Error("native attachment mime type is invalid");
      return {
        relativePath: assertAttachmentRelativePath(value.relativePath),
        mimeType,
        bytesBase64,
      };
    },
    async openVaultAttachment(relativePath) {
      const path = assertAttachmentRelativePath(relativePath);
      await invoke("open_vault_attachment", { request: { relativePath: path } });
    },
    async applyMarkdownChanges(changes) {
      if (changes.length === 0) throw new Error("at least one markdown change is required");
      for (const change of changes) {
        if (
          !/^[a-f0-9]{64}$/i.test(change.expectedSha256)
          || change.relativePath.length === 0
          || change.relativePath.length > 500
          || change.relativePath.includes("..")
          || change.relativePath.startsWith("/")
          || change.relativePath.includes("\\")
          || !change.relativePath.toLocaleLowerCase().endsWith(".md")
        ) throw new Error("markdown change is invalid");
        if (change.operation !== "delete" && !/^[A-Za-z0-9+/]*={0,2}$/.test(change.replacementBase64)) {
          throw new Error("markdown replacement is invalid");
        }
      }
      const value = assertRecord(await invoke("apply_markdown_changes", { changes }));
      assertExactKeys(value, ["journalPath", "backupPath"]);
      return {
        journalPath: assertString(value.journalPath, "journalPath", 4096),
        backupPath: assertString(value.backupPath, "backupPath", 4096),
      };
    },
    async checkAppUpdate() {
      return validateAppUpdateCheck(await invoke("check_app_update"));
    },
    async installAppUpdate() {
      // The native side re-checks the signed manifest and verifies the
      // installer signature; the renderer never supplies a download URL.
      await invoke("install_app_update");
    },
    async showReminder(title: string, body: string) {
      await invoke("show_reminder", { title, body });
    },
    inboxRelay: {
      async status() {
        return validateInboxRelayStatus(await invoke("inbox_relay_status"));
      },
      async pair() {
        return validateInboxRelayPairing(await invoke("inbox_relay_pair"));
      },
      async pairing() {
        return validateInboxRelayPairing(await invoke("inbox_relay_pairing"));
      },
      async rotate() {
        return validateInboxRelayPairing(await invoke("inbox_relay_rotate"));
      },
      async unpair() {
        await invoke("inbox_relay_unpair");
      },
      async pending() {
        return validateInboxRelayItems(await invoke("inbox_relay_pending"));
      },
      async ack(ids: string[]) {
        await invoke("inbox_relay_ack", { ids });
      },
      async entitlement() {
        return validateInboxRelayEntitlement(await invoke("inbox_relay_entitlement"));
      },
      async requestCode(email: string) {
        return validateInboxRelayEntitlement(await invoke("inbox_relay_request_code", { email }));
      },
      async verifyCode(code: string) {
        return validateInboxRelayEntitlement(await invoke("inbox_relay_verify_code", { code }));
      },
      async cancelEntitlement() {
        return validateInboxRelayEntitlement(await invoke("inbox_relay_cancel_entitlement"));
      },
      async publishSnapshot(snapshot) {
        return validateInboxRelayEntitlement(await invoke("inbox_relay_publish_snapshot", { snapshot }));
      },
    },
  };
}
