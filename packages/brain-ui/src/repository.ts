import type { TaskPriority, TaskStatus } from "@second-brain/brain-core";

export interface BrainTaskDto {
  id: string;
  title: string;
  status: TaskStatus;
  taskDate: string | null;
  /** @deprecated V2 response compatibility; always null in V3 responses. */
  dueDate?: string | null;
  /** @deprecated V2 response compatibility; mirrors taskDate during rollout. */
  plannedDate?: string | null;
  priority: TaskPriority;
  projectId: string | null;
  projectName: string | null;
  rank: string;
  sourcePath: string | null;
  sourceHeading: string | null;
  completedAt: string | null;
  startTime: string | null;
  durationMinutes: number | null;
  timeZone: string;
  schemaVersion?: 1 | 2 | 3 | 4 | 5 | 6;
  ownerEmail: string;
  version: number;
  pendingSync: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BrainProjectDto {
  id: string;
  name: string;
  sourcePath: string | null;
  status: string;
  area: string | null;
  priority: number | null;
  progress: number | null;
  focusToday: boolean;
  startDate: string | null;
  endDate: string | null;
  /** @deprecated V2 response compatibility; mirrors endDate during rollout. */
  targetDate?: string | null;
  completedAt: string | null;
  schemaVersion?: 1 | 2 | 3 | 4 | 5 | 6;
  ownerEmail: string;
  version: number;
  pendingSync: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BrainOwnerStateDto {
  revision: number;
  pendingCount: number;
  lastSyncAt: string | null;
}

export type OwnerStatePollResult =
  | { kind: "not-modified"; etag: string | null }
  | { kind: "modified"; etag: string | null; state: BrainOwnerStateDto };

export interface UpdateTaskDateInput {
  taskId: string;
  expectedVersion: number;
  taskDate: string | null;
}

export interface BrainRepository {
  listTasks(): Promise<BrainTaskDto[]>;
  listProjects(): Promise<BrainProjectDto[]>;
  getOwnerState(etag: string | null): Promise<OwnerStatePollResult>;
  updateTaskDate(input: UpdateTaskDateInput): Promise<BrainTaskDto>;
}

export class BrainRepositoryError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null = null,
  ) {
    super(message);
    this.name = "BrainRepositoryError";
  }
}

export class BrainConflictError extends BrainRepositoryError {
  constructor(message = "Task version is stale") {
    super(message, 409, "VERSION_CONFLICT");
    this.name = "BrainConflictError";
  }
}
