import {
  canonicalizeDeviceRequest,
  type DeviceCanonicalRequestInput,
} from "@second-brain/brain-core";

export interface DeviceIdentity {
  deviceId: string;
  publicKeyBase64Url: string;
  fingerprint: string;
  backend: string;
}

export interface SignResponse {
  signatureBase64Url: string;
}

export interface DiagnosticsSnapshot {
  selectedVault: string | null;
  watcherStatus: string;
  keyFingerprint: string;
  keyBackend: string;
  recoveryStatus: string;
  syncEnabled: boolean;
  publisherOrigin: string | null;
  closeBehavior: "hide_to_tray" | "exit";
  autostartEnabled: boolean;
}

export interface PublisherHttpRequest {
  origin: string;
  method: "GET" | "POST" | "DELETE";
  path: string;
  body: string | null;
  headers: Record<string, string>;
  signed: boolean;
}

export interface PublisherHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
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

export interface MarkdownChangeRequest {
  relativePath: string;
  expectedSha256: string;
  replacementBase64: string;
}

export interface MarkdownApplyResult {
  journalPath: string;
  backupPath: string;
}

export interface PendingCommitRecord {
  planId: string;
  idempotencyKey: string;
  choices: Array<{ entity: "task" | "project"; id: string; field: string; choice: "local" | "server" }>;
  journalPaths: string[];
}

export type NativeInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface NativeAdapter {
  getDeviceIdentity(): Promise<DeviceIdentity>;
  completeDevicePairing(deviceId: string): Promise<void>;
  signCanonicalRequest(request: DeviceCanonicalRequestInput): Promise<SignResponse>;
  publisherHttpRequest(request: PublisherHttpRequest): Promise<PublisherHttpResponse>;
  openPublisherPairing(origin: string, pairingId: string): Promise<void>;
  getDiagnostics(): Promise<DiagnosticsSnapshot>;
  pickVaultFolder(): Promise<string | null>;
  selectVault(path: string): Promise<{ vaultId: string; root: string }>;
  setAutostart(enabled: boolean): Promise<void>;
  setCloseBehavior(behavior: DiagnosticsSnapshot["closeBehavior"]): Promise<void>;
  scanVault(): Promise<ScannedMarkdownFile[]>;
  readMarkdownFiles(relativePaths: string[]): Promise<MarkdownFileContents[]>;
  applyMarkdownChanges(changes: MarkdownChangeRequest[]): Promise<MarkdownApplyResult>;
  confirmServerCommit(journalPath: string): Promise<void>;
  savePendingCommit(pending: PendingCommitRecord): Promise<void>;
  loadPendingCommit(): Promise<PendingCommitRecord | null>;
  clearPendingCommit(): Promise<void>;
  pendingJournals(): Promise<string[]>;
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

function assertUuid(value: unknown, name: string): string {
  const result = assertString(value, name, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) {
    throw new Error(`native response field ${name} is invalid`);
  }
  return result;
}

function validatePendingCommit(value: unknown): PendingCommitRecord {
  const record = assertRecord(value);
  assertExactKeys(record, ["planId", "idempotencyKey", "choices", "journalPaths"]);
  if (
    !Array.isArray(record.choices)
    || record.choices.length > 1_000
    || !Array.isArray(record.journalPaths)
    || record.journalPaths.length > 100
  ) {
    throw new Error("native pending commit is invalid");
  }
  const choices = record.choices.map((item) => {
    const choice = assertRecord(item);
    assertExactKeys(choice, ["entity", "id", "field", "choice"]);
    if (
      (choice.entity !== "task" && choice.entity !== "project")
      || (choice.choice !== "local" && choice.choice !== "server")
    ) {
      throw new Error("native pending commit is invalid");
    }
    const entity: "task" | "project" = choice.entity;
    const selection: "local" | "server" = choice.choice;
    return {
      entity,
      id: assertUuid(choice.id, "choice.id"),
      field: assertString(choice.field, "choice.field", 64),
      choice: selection,
    };
  });
  const journalPaths = record.journalPaths.map((item) => {
    const path = assertString(item, "journalPath", 4_096);
    if (!path.endsWith(".journal.json")) throw new Error("native pending commit is invalid");
    return path;
  });
  return {
    planId: assertUuid(record.planId, "planId"),
    idempotencyKey: assertUuid(record.idempotencyKey, "idempotencyKey"),
    choices,
    journalPaths,
  };
}

export function validateDeviceIdentity(value: unknown): DeviceIdentity {
  const record = assertRecord(value);
  assertExactKeys(record, ["deviceId", "publicKeyBase64Url", "fingerprint", "backend"]);
  const publicKeyBase64Url = assertString(record.publicKeyBase64Url, "publicKeyBase64Url", 128);
  const fingerprint = assertString(record.fingerprint, "fingerprint", 128);
  if (
    publicKeyBase64Url.length !== 43
    || !/^[A-Za-z0-9_-]+$/.test(publicKeyBase64Url)
    || !/^sha256:[a-f0-9]{64}$/i.test(fingerprint)
  ) {
    throw new Error("native public identity is invalid");
  }
  return {
    deviceId: assertString(record.deviceId, "deviceId", 128),
    publicKeyBase64Url,
    fingerprint,
    backend: assertString(record.backend, "backend", 64),
  };
}

export function validateSignResponse(value: unknown): SignResponse {
  const record = assertRecord(value);
  assertExactKeys(record, ["signatureBase64Url"]);
  const signatureBase64Url = assertString(record.signatureBase64Url, "signatureBase64Url", 128);
  if (signatureBase64Url.length !== 86 || !/^[A-Za-z0-9_-]+$/.test(signatureBase64Url)) {
    throw new Error("native signature is invalid");
  }
  return { signatureBase64Url };
}

function validateDiagnostics(value: unknown): DiagnosticsSnapshot {
  const record = assertRecord(value);
  assertExactKeys(record, [
    "selectedVault",
    "watcherStatus",
    "keyFingerprint",
    "keyBackend",
    "recoveryStatus",
    "syncEnabled",
    "publisherOrigin",
    "closeBehavior",
    "autostartEnabled",
  ]);
  const selectedVault = record.selectedVault;
  if (selectedVault !== null && typeof selectedVault !== "string") {
    throw new Error("native diagnostics vault is invalid");
  }
  const publisherOrigin = record.publisherOrigin;
  if (publisherOrigin !== null && typeof publisherOrigin !== "string") {
    throw new Error("native diagnostics publisher origin is invalid");
  }
  return {
    selectedVault,
    watcherStatus: assertString(record.watcherStatus, "watcherStatus"),
    keyFingerprint: assertString(record.keyFingerprint, "keyFingerprint"),
    keyBackend: assertString(record.keyBackend, "keyBackend"),
    recoveryStatus: assertString(record.recoveryStatus, "recoveryStatus"),
    syncEnabled: record.syncEnabled === true,
    publisherOrigin,
    closeBehavior: record.closeBehavior === "hide_to_tray" ? "hide_to_tray" : "exit",
    autostartEnabled: record.autostartEnabled === true,
  };
}

function validatePublisherRequest(request: PublisherHttpRequest): PublisherHttpRequest {
  const origin = new URL(request.origin);
  if (origin.origin !== request.origin || origin.username || origin.password) {
    throw new Error("publisher origin is invalid");
  }
  if (!/^(GET|POST|DELETE)$/.test(request.method)) throw new Error("publisher method is invalid");
  if (!request.path.startsWith("/api/brain/device/") || request.path.includes("?") || request.path.length > 512) {
    throw new Error("publisher path is invalid");
  }
  if (request.body !== null && request.body.length > 4_000_000) throw new Error("publisher body is too large");
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const normalized = name.toLowerCase();
    if (!['if-none-match', 'idempotency-key'].includes(normalized) || /[\r\n]/.test(value)) {
      throw new Error("publisher header is invalid");
    }
    headers[normalized] = value;
  }
  return { ...request, headers };
}

function validatePublisherResponse(value: unknown): PublisherHttpResponse {
  const record = assertRecord(value);
  assertExactKeys(record, ["status", "headers", "body"]);
  if (typeof record.status !== "number" || !Number.isInteger(record.status) || record.status < 100 || record.status > 599) {
    throw new Error("native publisher status is invalid");
  }
  const rawHeaders = assertRecord(record.headers);
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(rawHeaders)) {
    if (typeof headerValue !== "string" || name.length > 128 || headerValue.length > 8_192) {
      throw new Error("native publisher headers are invalid");
    }
    headers[name.toLowerCase()] = headerValue;
  }
  return {
    status: record.status,
    headers,
    body: typeof record.body === "string" && record.body.length <= 8_000_000
      ? record.body
      : (() => { throw new Error("native publisher body is invalid"); })(),
  };
}

async function defaultInvoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
  const module = await import("@tauri-apps/api/core");
  return module.invoke(command, args);
}

export function createNativeAdapter(invoke: NativeInvoke = defaultInvoke): NativeAdapter {
  return {
    async getDeviceIdentity() {
      return validateDeviceIdentity(await invoke("device_identity"));
    },
    async completeDevicePairing(deviceId) {
      await invoke("complete_device_pairing", { deviceId: assertUuid(deviceId, "device id") });
    },
    async signCanonicalRequest(request) {
      canonicalizeDeviceRequest(request);
      const response = await invoke("sign_canonical_request", { request });
      return validateSignResponse(response);
    },
    async publisherHttpRequest(request) {
      return validatePublisherResponse(await invoke("publisher_http_request", {
        request: validatePublisherRequest(request),
      }));
    },
    async openPublisherPairing(origin, pairingId) {
      const normalizedOrigin = new URL(origin);
      if (normalizedOrigin.origin !== origin || normalizedOrigin.username || normalizedOrigin.password) {
        throw new Error("publisher origin is invalid");
      }
      await invoke("open_publisher_pairing", {
        origin,
        pairingId: assertUuid(pairingId, "pairing id"),
      });
    },
    async getDiagnostics() {
      return validateDiagnostics(await invoke("diagnostics"));
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
    async applyMarkdownChanges(changes) {
      if (changes.length === 0) throw new Error("at least one markdown change is required");
      const value = assertRecord(await invoke("apply_markdown_changes", { changes }));
      assertExactKeys(value, ["journalPath", "backupPath"]);
      return {
        journalPath: assertString(value.journalPath, "journalPath", 4096),
        backupPath: assertString(value.backupPath, "backupPath", 4096),
      };
    },
    async confirmServerCommit(journalPath) {
      if (!journalPath.endsWith(".journal.json")) throw new Error("journal path is invalid");
      await invoke("confirm_server_commit", { journalPath });
    },
    async savePendingCommit(pending) {
      await invoke("save_pending_commit", { pending });
    },
    async loadPendingCommit() {
      const raw = await invoke("load_pending_commit");
      if (raw === null) return null;
      return validatePendingCommit(raw);
    },
    async clearPendingCommit() {
      await invoke("clear_pending_commit");
    },
    async pendingJournals() {
      const value = await invoke("pending_journals");
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.endsWith(".journal.json"))) {
        throw new Error("native pending journals are invalid");
      }
      return value as string[];
    },
  };
}
