import { z } from "zod";
import { isValidDateKey } from "./dates";

export const SNAPSHOT_SCHEMA_VERSION = 6 as const;
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
export const ProjectStatusSchema = z.enum([
  "planning",
  "active",
  "paused",
  "done",
  "archived",
]);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const DateSchema = z
  .string()
  .refine(isValidDateKey, "Invalid date key")
  .nullable();
const SchemaVersionSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
]).optional();
const TimeSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Invalid time")
  .nullable();

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
  startTime: TimeSchema.optional(),
  durationMinutes: z.number().int().min(5).max(1440).nullable().optional(),
  timeZone: z.string().min(1).max(100).nullable().optional(),
  // Local Markdown content. Cloud clients omit this field until the API supports it.
  body: z.string().max(2_000_000).optional(),
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
  completedAt: DateSchema.optional(),
  // Local Markdown content. Cloud clients omit this field until the API supports it.
  body: z.string().max(2_000_000).optional(),
  schemaVersion: SchemaVersionSchema,
}).strict();

export const BrainCollectionSnapshotSchema = z.object({
  id: z.string().nullable(),
  name: z.string().min(1).max(200),
  sourcePath: z.string().nullable(),
  category: z.string().max(200).nullable(),
  importance: z.number().int().min(1).max(3).nullable(),
  // Collection bodies are indexed locally and deliberately excluded from cloud plans.
  body: z.string().max(2_000_000),
  schemaVersion: SchemaVersionSchema,
}).strict();

export const RoutineTemplateItemSchema = z.object({
  id: z.string().min(1).max(100),
  title: z.string().trim().min(1).max(500),
  enabled: z.boolean(),
  projectId: z.string().nullable(),
  projectName: z.string().max(200).nullable(),
  priority: TaskPrioritySchema,
  startTime: TimeSchema,
  durationMinutes: z.number().int().min(5).max(1440).nullable(),
  rank: z.string().min(1).max(100),
}).strict();

export const RoutineTemplateSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(200),
  version: z.number().int().positive(),
  updatedAt: z.string().datetime(),
  items: z.array(RoutineTemplateItemSchema).max(100),
}).strict();

export const SyncSnapshotSchema = z.object({
  schemaVersion: SchemaVersionSchema,
  tasks: z.array(BrainTaskSnapshotSchema),
  projects: z.array(BrainProjectSnapshotSchema),
  collections: z.array(BrainCollectionSnapshotSchema).optional(),
  routineTemplates: z.array(RoutineTemplateSchema).optional(),
  fileHashes: z.record(z.string()).optional(),
}).strict();

export type BrainTaskSnapshot = z.infer<typeof BrainTaskSnapshotSchema>;
export type BrainProjectSnapshot = z.infer<typeof BrainProjectSnapshotSchema>;
export type BrainCollectionSnapshot = z.infer<typeof BrainCollectionSnapshotSchema>;
export type SyncSnapshot = z.infer<typeof SyncSnapshotSchema>;
export type RoutineTemplate = z.infer<typeof RoutineTemplateSchema>;
export type RoutineTemplateItem = z.infer<typeof RoutineTemplateItemSchema>;

export interface ParsedMarkdownTask extends BrainTaskSnapshot {
  lineIndex: number;
  rawLine: string;
}

export interface ParsedProjectFrontmatter extends BrainProjectSnapshot {
  sourcePath: string;
  frontmatterStart: number;
  frontmatterEnd: number;
}

export interface ParsedCollectionFrontmatter extends BrainCollectionSnapshot {
  sourcePath: string;
  frontmatterStart: number;
  frontmatterEnd: number;
}

export type TaskLineInput = BrainTaskSnapshot;
