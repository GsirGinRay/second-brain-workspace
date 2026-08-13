import {
  DEVICE_SIGNATURE_HEADERS,
  type BrainProjectSnapshot,
  type BrainTaskSnapshot,
  type DevicePairStartResultDto,
  type DevicePairStatusDto,
} from "@second-brain/brain-core";
import type { NativeAdapter } from "./ipc";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export const DEFAULT_SERVER_ORIGIN = "";

const browserFetch: Fetcher = (input, init) => globalThis.fetch(input, init);

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
  if (!loopback) {
    throw new Error("Remote cloud sync is not configured in this open-source build");
  }
  return url.origin;
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function responseError(response: Response): Promise<Error> {
  try {
    const value = await response.json() as { error?: string | { code?: string; message?: string } };
    const message = typeof value.error === "string" ? value.error : value.error?.code ?? value.error?.message;
    return new Error(message || `HTTP_${response.status}`);
  } catch {
    return new Error(`HTTP_${response.status}`);
  }
}

export class DeviceClient {
  readonly origin: string;

  constructor(
    origin: string,
    private readonly native: NativeAdapter,
    private readonly fetcher: Fetcher = browserFetch,
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

  async getState(etag: string | null): Promise<
    { kind: "not-modified"; etag: string | null } | { kind: "modified"; etag: string | null; state: DeviceOwnerState }
  > {
    const response = await this.signedRequest("GET", "/api/brain/device/state", undefined, etag ? { "if-none-match": etag } : {});
    const responseEtag = response.headers.get("etag") ?? etag;
    if (response.status === 304) return { kind: "not-modified", etag: responseEtag };
    if (!response.ok) throw await responseError(response);
    return { kind: "modified", etag: responseEtag, state: await response.json() as DeviceOwnerState };
  }

  async createPlan(input: {
    schemaVersion: 2 | 3;
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
    if (!response.ok) throw await responseError(response);
    return response.json() as Promise<DevicePlanStatus>;
  }

  async deleteTaskPermanently(taskId: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(taskId)) throw new Error("TASK_ID_INVALID");
    const response = await this.signedRequest("DELETE", `/api/brain/device/tasks/${taskId}`);
    if (!response.ok) throw await responseError(response);
  }

  private async unsignedJson<T>(path: string, body: unknown, expectedStatus = 200): Promise<T> {
    const response = await this.fetcher(this.origin + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (response.status !== expectedStatus) throw await responseError(response);
    return response.json() as Promise<T>;
  }

  private async signedJson<T>(method: string, path: string, body: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    const response = await this.signedRequest(method, path, body, extraHeaders);
    if (!response.ok) throw await responseError(response);
    return response.json() as Promise<T>;
  }

  private async signedRequest(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const identity = await this.native.getDeviceIdentity();
    const bodyText = body === undefined ? "" : JSON.stringify(body);
    const bodyBytes = new TextEncoder().encode(bodyText);
    const timestamp = Math.floor(Date.now() / 1_000);
    const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
    const nonce = base64Url(nonceBytes);
    const contentType = body === undefined ? "" : "application/json";
    const canonical = {
      method,
      path,
      query: [] as [string, string][],
      timestamp,
      nonce,
      contentType,
      bodySha256: await sha256Hex(bodyBytes),
    };
    const signature = await this.native.signCanonicalRequest(canonical);
    const headers = new Headers(extraHeaders);
    headers.set(DEVICE_SIGNATURE_HEADERS.deviceId, identity.deviceId);
    headers.set(DEVICE_SIGNATURE_HEADERS.timestamp, String(timestamp));
    headers.set(DEVICE_SIGNATURE_HEADERS.nonce, nonce);
    headers.set(DEVICE_SIGNATURE_HEADERS.signature, signature.signatureBase64Url);
    if (contentType) headers.set("content-type", contentType);
    return this.fetcher(this.origin + path, {
      method,
      headers,
      body: body === undefined ? undefined : bodyText,
      cache: "no-store",
    });
  }
}
