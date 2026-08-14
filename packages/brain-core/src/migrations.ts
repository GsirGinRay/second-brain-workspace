import {
  BrainProjectSnapshotSchema,
  BrainTaskSnapshotSchema,
  SNAPSHOT_SCHEMA_VERSION,
  SyncSnapshotSchema,
  type BrainProjectSnapshot,
  type BrainTaskSnapshot,
  type SyncSnapshot,
} from "./types";

export type VersionedTaskSnapshot = Omit<BrainTaskSnapshot, "plannedDate" | "dueDate"> & {
  taskDate: string | null;
  startTime: string | null;
  durationMinutes: number | null;
  timeZone: string;
  schemaVersion: 4;
};
export type VersionedProjectSnapshot = Omit<BrainProjectSnapshot, "targetDate"> & {
  startDate: string | null;
  endDate: string | null;
  completedAt: string | null;
  schemaVersion: 4;
};
export type VersionedSyncSnapshot = Omit<SyncSnapshot, "schemaVersion" | "tasks" | "projects"> & {
  schemaVersion: 4;
  tasks: VersionedTaskSnapshot[];
  projects: VersionedProjectSnapshot[];
};

export function migrateTaskSnapshot(value: unknown): VersionedTaskSnapshot {
  const parsed = BrainTaskSnapshotSchema.parse(value);
  const { plannedDate, dueDate, ...rest } = parsed;
  return {
    ...rest,
    taskDate: parsed.taskDate ?? plannedDate ?? dueDate ?? null,
    startTime: parsed.startTime ?? null,
    durationMinutes: parsed.startTime ? (parsed.durationMinutes ?? 30) : null,
    timeZone: parsed.timeZone ?? "Asia/Taipei",
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
  };
}

export function migrateProjectSnapshot(value: unknown): VersionedProjectSnapshot {
  const parsed = BrainProjectSnapshotSchema.parse(value);
  const { targetDate, ...rest } = parsed;
  return {
    ...rest,
    startDate: parsed.startDate ?? null,
    endDate: parsed.endDate ?? targetDate ?? null,
    completedAt: parsed.completedAt ?? null,
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
  };
}

export function migrateSyncSnapshot(value: unknown): VersionedSyncSnapshot {
  const parsed = SyncSnapshotSchema.parse(value);
  return {
    ...(parsed.fileHashes === undefined ? {} : { fileHashes: parsed.fileHashes }),
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    tasks: parsed.tasks.map(migrateTaskSnapshot),
    projects: parsed.projects.map(migrateProjectSnapshot),
  };
}

export function parseSyncSnapshot(value: unknown): VersionedSyncSnapshot {
  return migrateSyncSnapshot(value);
}

export function tryMigrateTaskSnapshot(value: unknown): VersionedTaskSnapshot | null {
  const result = BrainTaskSnapshotSchema.safeParse(value);
  return result.success ? migrateTaskSnapshot(result.data) : null;
}

export function tryMigrateProjectSnapshot(value: unknown): VersionedProjectSnapshot | null {
  const result = BrainProjectSnapshotSchema.safeParse(value);
  return result.success ? migrateProjectSnapshot(result.data) : null;
}
