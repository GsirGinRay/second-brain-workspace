/**
 * Phone inbox: items the native side received and decrypted from the relay
 * (docs/inbox-relay.md) become inbox tasks, parsed like a quick add.
 */
import {
  SNAPSHOT_TASK_LIMIT,
  SNAPSHOT_TITLE_LIMIT,
  isInboxItemId,
  parseSnapshot,
  rankForIndex,
  type BrainTaskSnapshot,
  type InboxSnapshot,
  type InboxSource,
  type SnapshotTask,
} from "@second-brain/brain-core";
import { addDateDays } from "@second-brain/brain-ui";
import { parseNaturalDate } from "./natural-date";
import { archiveTask } from "./task-actions";

export interface InboxRelayItem {
  id: string;
  text: string;
  createdAt: string;
  source: InboxSource;
  /** Set when the phone ticked a task in its "today" list. */
  action?: "complete";
  taskId?: string;
}

/** The paid phone "today" list, or the relay's reason for refusing a request. */
export interface InboxRelayEntitlement {
  entitled: boolean;
  email: string | null;
  error: string | null;
}

export interface InboxRelayStatus {
  paired: boolean;
  /** A pairing exists but this Windows account cannot open its key. */
  needsRepair: boolean;
  connection: "connecting" | "connected" | "offline" | null;
  origin: string;
  pending: number;
  discarded: number;
}

export interface InboxRelayPairing {
  url: string;
  qrSvg: string;
}

export interface InboxRelayApi {
  status(): Promise<InboxRelayStatus>;
  pair(): Promise<InboxRelayPairing>;
  pairing(): Promise<InboxRelayPairing>;
  rotate(): Promise<InboxRelayPairing>;
  unpair(): Promise<void>;
  pending(): Promise<InboxRelayItem[]>;
  ack(ids: string[]): Promise<void>;
  entitlement(): Promise<InboxRelayEntitlement>;
  requestCode(email: string): Promise<InboxRelayEntitlement>;
  verifyCode(code: string): Promise<InboxRelayEntitlement>;
  cancelEntitlement(): Promise<InboxRelayEntitlement>;
  publishSnapshot(snapshot: InboxSnapshot): Promise<InboxRelayEntitlement>;
}

const SOURCES = new Set<InboxSource>(["pwa", "line", "email"]);
const CONNECTIONS = new Set(["connecting", "connected", "offline"]);

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid inbox relay response");
  }
  return value as Record<string, unknown>;
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Invalid inbox relay response");
  }
  return value;
}

export function validateInboxRelayStatus(value: unknown): InboxRelayStatus {
  const input = record(value);
  const connection = input.connection;
  if (
    typeof input.paired !== "boolean"
    || typeof input.needsRepair !== "boolean"
    || typeof input.origin !== "string"
    || (connection !== null && (typeof connection !== "string" || !CONNECTIONS.has(connection)))
  ) {
    throw new Error("Invalid inbox relay status");
  }
  return {
    paired: input.paired,
    needsRepair: input.needsRepair,
    connection: connection as InboxRelayStatus["connection"],
    origin: input.origin,
    pending: count(input.pending),
    discarded: count(input.discarded),
  };
}

export function validateInboxRelayPairing(value: unknown): InboxRelayPairing {
  const input = record(value);
  if (
    typeof input.url !== "string"
    || !/^https?:\/\/[^/#?]+\/#v=1&i=[A-Za-z0-9_-]{22}&t=[A-Za-z0-9_-]+&k=[A-Za-z0-9_-]+(&s=[A-Za-z0-9_-]{43})?$/.test(input.url)
    || typeof input.qrSvg !== "string"
    || !input.qrSvg.startsWith("<?xml")
  ) {
    throw new Error("Invalid inbox relay pairing");
  }
  return { url: input.url, qrSvg: input.qrSvg };
}

export function validateInboxRelayItems(value: unknown): InboxRelayItem[] {
  if (!Array.isArray(value)) throw new Error("Invalid inbox relay items");
  return value.map((entry) => {
    const input = record(entry);
    if (
      typeof input.id !== "string"
      || !isInboxItemId(input.id)
      || typeof input.text !== "string"
      || input.text.trim() === ""
      || typeof input.createdAt !== "string"
      || typeof input.source !== "string"
      || !SOURCES.has(input.source as InboxSource)
      || (input.action !== undefined && input.action !== "complete")
      || (input.action === "complete") !== (typeof input.taskId === "string" && input.taskId !== "")
    ) {
      throw new Error("Invalid inbox relay item");
    }
    const item: InboxRelayItem = { id: input.id, text: input.text, createdAt: input.createdAt, source: input.source as InboxSource };
    if (input.action === "complete") {
      item.action = "complete";
      item.taskId = input.taskId as string;
    }
    return item;
  });
}

export function validateInboxRelayEntitlement(value: unknown): InboxRelayEntitlement {
  const input = record(value);
  if (
    typeof input.entitled !== "boolean"
    || (input.email !== null && input.email !== undefined && typeof input.email !== "string")
    || (input.error !== null && input.error !== undefined && (typeof input.error !== "string" || !/^[a-z_]{1,40}$/.test(input.error)))
  ) {
    throw new Error("Invalid inbox relay entitlement");
  }
  return {
    entitled: input.entitled,
    email: typeof input.email === "string" ? input.email : null,
    error: typeof input.error === "string" ? input.error : null,
  };
}

/** Days after today that the phone list shows. */
export const SNAPSHOT_UPCOMING_DAYS = 3;
const PRIORITY_ORDER: Record<BrainTaskSnapshot["priority"], number> = { highest: 0, high: 1, medium: 2, normal: 3, low: 4 };

/**
 * What the phone shows: open tasks that are overdue, due today or within the
 * next three days. Only titles, times, priority and project names leave the
 * computer, never notes.
 */
export function buildTodaySnapshot(tasks: readonly BrainTaskSnapshot[], today: string, now = new Date()): InboxSnapshot {
  const last = addDateDays(today, SNAPSHOT_UPCOMING_DAYS);
  const picked: SnapshotTask[] = tasks
    .filter((task) => task.status !== "done" && Boolean(task.taskDate) && (task.taskDate as string) <= last && Boolean(task.id))
    .sort((left, right) =>
      (left.taskDate ?? "").localeCompare(right.taskDate ?? "")
      || PRIORITY_ORDER[left.priority] - PRIORITY_ORDER[right.priority]
      || (left.startTime ?? "99:99").localeCompare(right.startTime ?? "99:99")
      || left.rank.localeCompare(right.rank))
    .slice(0, SNAPSHOT_TASK_LIMIT)
    .map((task) => ({
      id: task.id as string,
      title: (task.title.trim() || "（無標題）").slice(0, SNAPSHOT_TITLE_LIMIT),
      date: task.taskDate ?? null,
      time: task.startTime ?? null,
      durationMinutes: task.startTime && task.durationMinutes ? task.durationMinutes : null,
      priority: task.priority,
      status: task.status,
      project: task.projectName ? task.projectName.slice(0, 200) : null,
    }));
  return parseSnapshot({ v: 1, generatedAt: now.toISOString(), today, tasks: picked });
}

/** Ticks from the phone mark tasks done; other items become new inbox tasks. */
export function applyInboxItems(
  tasks: readonly BrainTaskSnapshot[],
  items: readonly InboxRelayItem[],
  today: string,
): BrainTaskSnapshot[] {
  const completed = new Set(items.filter((item) => item.action === "complete").map((item) => item.taskId));
  const updated = tasks.map((task) =>
    task.id && completed.has(task.id) && task.status !== "done" ? archiveTask(task, today) : task);
  return [...updated, ...inboxItemsToTasks(items.filter((item) => item.action !== "complete"), today)];
}

/** A data URL for the pairing QR code; the SVG comes from the native side. */
export function qrDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Like quick add: a duration only counts with a start time, otherwise its words stay. */
function parseInboxText(text: string, today: string) {
  const parsed = parseNaturalDate(text, today);
  if (parsed?.durationMinutes && !parsed.time) {
    return parseNaturalDate(text, today, { kinds: ["date", "time", "recurrence"] });
  }
  return parsed;
}

/**
 * The first line becomes the title, read for dates, times, durations and
 * repeats the same way quick add does; any further lines become the body.
 * Items keep the order they were sent in.
 */
export function inboxItemsToTasks(items: readonly InboxRelayItem[], today: string, rankSeed = Date.now()): BrainTaskSnapshot[] {
  return [...items]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((item, index) => {
      const [firstLine = "", ...rest] = item.text.split("\n");
      const typed = firstLine.trim();
      const natural = parseInboxText(typed, today);
      const title = (natural?.title.trim() || typed).slice(0, 500);
      const startTime = natural?.time ?? null;
      const task: BrainTaskSnapshot = {
        schemaVersion: 5,
        id: crypto.randomUUID(),
        title,
        status: "todo",
        // A time alone means today; no date at all leaves it undated in the inbox.
        taskDate: natural?.date ?? (startTime ? today : null),
        priority: "normal",
        projectId: null,
        projectName: null,
        rank: rankForIndex((rankSeed + index) % 100000),
        sourcePath: null,
        sourceHeading: null,
        completedAt: null,
        startTime,
        durationMinutes: startTime ? (natural?.durationMinutes ?? 30) : null,
        timeZone: "Asia/Taipei",
      };
      const body = rest.join("\n").trim();
      if (body) task.body = body;
      if (natural?.recurrence) task.recurrence = natural.recurrence;
      return task;
    });
}
