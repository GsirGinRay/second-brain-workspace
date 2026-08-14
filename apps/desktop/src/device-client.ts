import {
  type BrainProjectSnapshot,
  type BrainTaskSnapshot,
  type DevicePairStartResultDto,
  type DevicePairStatusDto,
} from "@second-brain/brain-core";
import type { NativeAdapter, PublisherHttpResponse } from "./ipc";
export const DEFAULT_SERVER_ORIGIN = "";

export interface DeviceOwnerState {
  revision: number;
  pendingCount: number;
  lastSyncAt: string | null;
}

export interface DevicePlanResponse {
  planId: string;
  baseRevision: number;
  targetRevision: number;
  payloadDigest: string;
  expiresAt: string;
  desiredTasks: BrainTaskSnapshot[];
  desiredProjects: BrainProjectSnapshot[];
  conflicts: Array<{
    entity: "task" | "project";
    id: string;
    fields: string[];
    local: Record<string, unknown>;
    server: Record<string, unknown>;
  }>;
}

export interface ConflictChoice {
  entity: "task" | "project";
  id: string;
  field: string;
  choice: "local" | "server";
}

export interface DevicePlanStatus {
  status: "planned" | "conflict" | "committed" | "expired" | "failed";
  payloadDigest: string;
  expiresAt: string;
  commitResult: { ok: boolean; taskCount: number; projectCount: number } | null;
}

export function normalizeServerOrigin(value: string): string {
  const url = new URL(value.trim());
  if (url.username || url.password) throw new Error("Server URL must not contain credentials");
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    throw new Error("Server URL must use HTTPS");
  }
  return url.origin;
}

export class PublisherHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
  ) {
    super(`HTTP ${status} · ${code} · ${detail}`);
    this.name = "PublisherHttpError";
  }
}

function responseError(response: PublisherHttpResponse): Error {
  try {
    const value = JSON.parse(response.body) as { error?: string | { code?: string; message?: string }; code?: string; message?: string };
    const stringError = typeof value.error === "string" ? value.error : undefined;
    const code = typeof value.error === "object"
      ? value.error.code
      : value.code ?? (stringError && /^[A-Z][A-Z0-9_]+$/.test(stringError) ? stringError : undefined);
    const detail = stringError ?? (typeof value.error === "object" ? value.error.message : undefined) ?? value.message;
    return new PublisherHttpError(response.status, code || `HTTP_${response.status}`, detail || readableHttpStatus(response.status));
  } catch {
    return new PublisherHttpError(response.status, `HTTP_${response.status}`, readableHttpStatus(response.status));
  }
}

function readableHttpStatus(status: number): string {
  if (status === 400) return "Publisher 拒絕了請求格式";
  if (status === 401) return "裝置尚未配對、已撤銷，或簽章驗證失敗";
  if (status === 403) return "目前帳號或裝置沒有同步權限";
  if (status === 404) return "Publisher 同步端點不存在";
  if (status === 409) return "同步版本衝突，請重新產生預覽";
  if (status === 429) return "請求過於頻繁，請稍後再試";
  if (status >= 500) return "Publisher 伺服器暫時無法完成同步";
  return "Publisher 回傳未預期的狀態";
}

export class DeviceClient {
  readonly origin: string;

  constructor(
    origin: string,
    private readonly native: NativeAdapter,
  ) {
    this.origin = normalizeServerOrigin(origin);
  }

  async startPairing(name: string, platform = "windows"): Promise<DevicePairStartResultDto> {
    const identity = await this.native.getDeviceIdentity();
    return this.unsignedJson("/api/brain/device/pair/start", {
      name,
      platform,
      publicKey: identity.publicKeyBase64Url,
    }, 201);
  }

  async pairingStatus(pairingId: string, pollingSecret: string): Promise<DevicePairStatusDto> {
    return this.unsignedJson("/api/brain/device/pair/status", { pairingId, pollingSecret });
  }

  async openPairingPage(pairingId: string): Promise<void> {
    await this.native.openPublisherPairing(this.origin, pairingId);
  }

  async getState(etag: string | null): Promise<
    { kind: "not-modified"; etag: string | null } | { kind: "modified"; etag: string | null; state: DeviceOwnerState }
  > {
    const response = await this.signedRequest("GET", "/api/brain/device/state", undefined, etag ? { "if-none-match": etag } : {});
    const responseEtag = response.headers.etag ?? etag;
    if (response.status === 304) return { kind: "not-modified", etag: responseEtag };
    if (response.status < 200 || response.status >= 300) throw responseError(response);
    return { kind: "modified", etag: responseEtag, state: JSON.parse(response.body) as DeviceOwnerState };
  }

  async createPlan(input: {
    schemaVersion: 2 | 3 | 4;
    baseRevision: number;
    tasks: BrainTaskSnapshot[];
    projects: BrainProjectSnapshot[];
    fileHashes: Record<string, string>;
  }): Promise<DevicePlanResponse> {
    return this.signedJson("POST", "/api/brain/device/sync/plan", input);
  }

  async commitPlan(planId: string, choices: ConflictChoice[], idempotencyKey: string = crypto.randomUUID()): Promise<unknown> {
    return this.signedJson(
      "POST",
      "/api/brain/device/sync/commit",
      { planId, idempotencyKey, choices },
      { "idempotency-key": idempotencyKey },
    );
  }

  async getPlanStatus(planId: string): Promise<DevicePlanStatus> {
    if (!/^[0-9a-f-]{36}$/i.test(planId)) throw new Error("SYNC_PLAN_ID_INVALID");
    const path = `/api/brain/device/sync/plans/${planId}`;
    const response = await this.signedRequest("GET", path);
    if (response.status < 200 || response.status >= 300) throw responseError(response);
    return JSON.parse(response.body) as DevicePlanStatus;
  }

  async deleteTaskPermanently(taskId: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(taskId)) throw new Error("TASK_ID_INVALID");
    const response = await this.signedRequest("DELETE", `/api/brain/device/tasks/${taskId}`);
    if (response.status < 200 || response.status >= 300) throw responseError(response);
  }

  private async unsignedJson<T>(path: string, body: unknown, expectedStatus = 200): Promise<T> {
    const response = await this.native.publisherHttpRequest({
      origin: this.origin, method: "POST", path, body: JSON.stringify(body), headers: {}, signed: false,
    });
    if (response.status !== expectedStatus) throw responseError(response);
    return JSON.parse(response.body) as T;
  }

  private async signedJson<T>(method: string, path: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    const response = await this.signedRequest(method, path, body, extraHeaders);
    if (response.status < 200 || response.status >= 300) throw responseError(response);
    return JSON.parse(response.body) as T;
  }

  private async signedRequest(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<PublisherHttpResponse> {
    return this.native.publisherHttpRequest({
      origin: this.origin,
      method: method as "GET" | "POST" | "DELETE",
      path,
      body: body === undefined ? null : JSON.stringify(body),
      headers: extraHeaders,
      signed: true,
    });
  }
}
