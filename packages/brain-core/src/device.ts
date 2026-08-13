import type { BrainProjectSnapshot, BrainTaskSnapshot } from "./types";

export interface DevicePairStartDto {
  name: string;
  platform: string;
  publicKey: string;
}

export interface DevicePairStartResultDto {
  pairingId: string;
  pollingSecret: string;
  userCode: string;
  expiresAt: string;
}

export interface DevicePairStatusRequestDto {
  pairingId: string;
  pollingSecret: string;
}

export interface DevicePairStatusDto {
  status: "pending" | "paired";
  deviceId?: string;
}

export interface DevicePairApprovalDto {
  pairingId?: string;
  userCode: string;
}

export interface DevicePairApprovalResultDto {
  deviceId: string;
  pairingId: string;
}

export interface BrainDeviceDto {
  id: string;
  name: string;
  platform: string;
  status: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface BrainDeviceListDto {
  devices: BrainDeviceDto[];
}

export interface DeviceRevokeResultDto {
  ok: true;
  deviceId: string;
}

export interface DeviceSyncPlanDto {
  schemaVersion: 2;
  baseRevision: number;
  tasks: BrainTaskSnapshot[];
  projects: BrainProjectSnapshot[];
  fileHashes: Record<string, string>;
}

export interface DeviceSyncPlanStatusDto {
  status: "planned" | "conflict" | "committed" | "expired" | "failed";
  payloadDigest: string;
  expiresAt: string;
  commitResult: {
    ok: boolean;
    taskCount: number;
    projectCount: number;
  } | null;
}

export interface DeviceSyncCommitDto {
  planId: string;
  idempotencyKey: string;
  choices: ReadonlyArray<{
    entity: "task" | "project";
    id: string;
    field: string;
    choice: "local" | "server";
  }>;
}
