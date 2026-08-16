import {
  BrainProjectSnapshotSchema,
  BrainCollectionSnapshotSchema,
  BrainTaskSnapshotSchema,
  SNAPSHOT_SCHEMA_VERSION,
  SyncSnapshotSchema,
  type BrainProjectSnapshot,
  type BrainCollectionSnapshot,
  type BrainTaskSnapshot,
  type SyncSnapshot,
} from "./types";

export type VersionedTaskSnapshot = Omit<BrainTaskSnapshot, "plannedDate" | "dueDate"> & {
  taskDate: string | null;
  startTime: string | null;
  durationMinutes: number | null;
  timeZone: string;
  schemaVersion: 6;
};
export type VersionedProjectSnapshot = Omit<BrainProjectSnapshot, "targetDate"> & {
  startDate: string | null;
  endDate: string | null;
  completedAt: string | null;
  schemaVersion: 6;
};
export type VersionedCollectionSnapshot = Omit<BrainCollectionSnapshot, "schemaVersion"> & {
  schemaVersion: 6;
};
export type VersionedSyncSnapshot = Omit<SyncSnapshot, "schemaVersion" | "tasks" | "projects" | "collections"> & {
  schemaVersion: 6;
  tasks: VersionedTaskSnapshot[];
  projects: VersionedProjectSnapshot[];
  collections: VersionedCollectionSnapshot[];
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

export function migrateCollectionSnapshot(value: unknown): VersionedCollectionSnapshot {
  return {
    ...BrainCollectionSnapshotSchema.parse(value),
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
    collections: (parsed.collections ?? []).map(migrateCollectionSnapshot),
    routineTemplates: parsed.routineTemplates ?? [],
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

export function tryMigrateCollectionSnapshot(value: unknown): VersionedCollectionSnapshot | null {
  const result = BrainCollectionSnapshotSchema.safeParse(value);
  return result.success ? migrateCollectionSnapshot(result.data) : null;
}
