import { z } from "zod";
import { isValidDateKey } from "./dates";

export const SNAPSHOT_SCHEMA_VERSION = 3 as const;
export type SnapshotSchemaVersion = typeof SNAPSHOT_SCHEMA_VERSION;

export const TaskStatusSchema = z.enum(["todo", "doing", "waiting", "done"]);
export const TaskPrioritySchema = z.enum([
  "highest",
  "high",
  "medium",
  "normal",
  "low",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

export const DateSchema = z
  .string()
  .refine(isValidDateKey, "Invalid date key")
  .nullable();
const SchemaVersionSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]).optional();

export const BrainTaskSnapshotSchema = z.object({
  id: z.string().nullable(),
  title: z.string(),
  status: TaskStatusSchema,
  taskDate: DateSchema.optional(),
  // Expand/contract compatibility only. V3 UI and Markdown never write these.
  dueDate: DateSchema.optional(),
  plannedDate: DateSchema.optional(),
  priority: TaskPrioritySchema,
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  rank: z.string(),
  sourcePath: z.string().nullable(),
  sourceHeading: z.string().nullable(),
  completedAt: DateSchema,
  schemaVersion: SchemaVersionSchema,
}).strict();

export const BrainProjectSnapshotSchema = z.object({
  id: z.string().nullable(),
  name: z.string(),
  sourcePath: z.string().nullable(),
  status: z.string(),
  area: z.string().nullable(),
  priority: z.number().int().nullable(),
  progress: z.number().int().min(0).max(100).nullable(),
  focusToday: z.boolean(),
  startDate: DateSchema.optional(),
  endDate: DateSchema.optional(),
  // Expand/contract compatibility only. V3 writes endDate.
  targetDate: DateSchema.optional(),
  schemaVersion: SchemaVersionSchema,
}).strict();

export const SyncSnapshotSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  tasks: z.array(BrainTaskSnapshotSchema),
  projects: z.array(BrainProjectSnapshotSchema),
  fileHashes: z.record(z.string()).optional(),
}).strict();

export type BrainTaskSnapshot = z.infer<typeof BrainTaskSnapshotSchema>;
export type BrainProjectSnapshot = z.infer<typeof BrainProjectSnapshotSchema>;
export type SyncSnapshot = z.infer<typeof SyncSnapshotSchema>;

export interface ParsedMarkdownTask extends BrainTaskSnapshot {
  lineIndex: number;
  rawLine: string;
}

export interface ParsedProjectFrontmatter extends BrainProjectSnapshot {
  sourcePath: string;
  frontmatterStart: number;
  frontmatterEnd: number;
}

export type TaskLineInput = BrainTaskSnapshot;
