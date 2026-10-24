/**
 * Phone inbox: items the native side received and decrypted from the relay
 * (docs/inbox-relay.md) become inbox tasks, parsed like a quick add.
 */
import {
  INBOX_ACTIONS,
  SNAPSHOT_NOTES_LIMIT,
  SNAPSHOT_PROJECT_LIMIT,
  SNAPSHOT_TASK_LIMIT,
  SNAPSHOT_TITLE_LIMIT,
  isInboxItemId,
  isValidDateKey,
  parseSnapshot,
  rankForIndex,
  type BrainProjectSnapshot,
  type BrainTaskSnapshot,
  type InboxAction,
  type InboxSnapshot,
  type InboxSource,
  type SnapshotTask,
} from "@second-brain/brain-core";
import { addDateDays } from "@second-brain/brain-ui";
import { parseNaturalDate } from "./natural-date";
import { archiveTask, markMostImportant, scheduleTask } from "./task-actions";

export interface InboxRelayItem {
  id: string;
  text: string;
  createdAt: string;
  source: InboxSource;
  /** Set when the phone changed a task in its "today" list. */
  action?: InboxAction;
  taskId?: string;
  /** The new date of a reschedule, or the date picked for an added task. */
  date?: string;
  /** The project picked for an added task. */
  projectId?: string;
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
const ACTIONS = new Set<string>(INBOX_ACTIONS);
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
      || (input.action !== undefined && (typeof input.action !== "string" || !ACTIONS.has(input.action)))
      || (input.action !== undefined) !== (typeof input.taskId === "string" && input.taskId !== "")
      || (input.date !== undefined && (typeof input.date !== "string" || !isValidDateKey(input.date)))
      || (input.action === "reschedule") !== (input.action !== undefined && input.date !== undefined)
      || (input.projectId !== undefined && (typeof input.projectId !== "string" || input.projectId === "" || input.action !== undefined))
    ) {
      throw new Error("Invalid inbox relay item");
    }
    const item: InboxRelayItem = { id: input.id, text: input.text, createdAt: input.createdAt, source: input.source as InboxSource };
    if (input.action !== undefined) {
      item.action = input.action as InboxAction;
      item.taskId = input.taskId as string;
    }
    if (typeof input.date === "string") item.date = input.date;
    if (typeof input.projectId === "string") item.projectId = input.projectId;
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

/** Days after today that the phone list can show; the phone picks 3 or 7. */
export const SNAPSHOT_UPCOMING_DAYS = 7;
/** Plaintext budget, well under the relay's 128 KB for the sealed envelope. */
const SNAPSHOT_PLAINTEXT_BYTES = 90_000;
const PRIORITY_ORDER: Record<BrainTaskSnapshot["priority"], number> = { highest: 0, high: 1, medium: 2, normal: 3, low: 4 };
const CLOSED_PROJECTS = new Set(["done", "archived"]);

/** The first characters of a task's notes, cut on a whole character. */
export function notesPreview(body: string | undefined): string | undefined {
  const text = (body ?? "").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return undefined;
  let preview = "";
  for (const character of text) {
    if (preview.length + character.length > SNAPSHOT_NOTES_LIMIT) break;
    preview += character;
  }
  return preview;
}

export interface TodaySnapshotOptions {
  now?: Date;
  /** Open projects become the phone's choices for new tasks. */
  projects?: readonly BrainProjectSnapshot[];
  /** Sends the first 200 characters of each task's notes. */
  includeNotes?: boolean;
}

/**
 * What the phone shows: open tasks that are overdue, due today or within the
 * next seven days, with titles, times, priority, repeat and project names.
 * Notes leave the computer only when the user allows it, and then only their
 * first 200 characters.
 */
export function buildTodaySnapshot(
  tasks: readonly BrainTaskSnapshot[],
  today: string,
  { now = new Date(), projects = [], includeNotes = false }: TodaySnapshotOptions = {},
): InboxSnapshot {
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
      ...(task.recurrence ? { recurrence: task.recurrence } : {}),
      ...(includeNotes && notesPreview(task.body) ? { notes: notesPreview(task.body) } : {}),
    }));
  const snapshot: InboxSnapshot = {
    v: 1,
    generatedAt: now.toISOString(),
    today,
    tasks: picked,
    doneToday: tasks.filter((task) => task.status === "done" && task.completedAt === today).length,
    projects: projects
      .filter((project) => project.id && project.name.trim() && !CLOSED_PROJECTS.has(project.status))
      .sort((left, right) => Number(right.focusToday) - Number(left.focusToday) || left.name.localeCompare(right.name, "zh-Hant"))
      .slice(0, SNAPSHOT_PROJECT_LIMIT)
      .map((project) => ({ id: project.id as string, name: project.name.trim().slice(0, 200) })),
    features: ["reschedule", "focus", "add-options"],
  };
  return parseSnapshot(fitSnapshot(snapshot));
}

/** Drops notes, then the furthest tasks, until the snapshot fits the relay. */
function fitSnapshot(snapshot: InboxSnapshot): InboxSnapshot {
  const size = (value: InboxSnapshot) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (size(snapshot) <= SNAPSHOT_PLAINTEXT_BYTES) return snapshot;
  const tasks = snapshot.tasks.map(({ notes: _notes, ...task }) => task);
  const fitted = { ...snapshot, tasks };
  while (tasks.length > 0 && size(fitted) > SNAPSHOT_PLAINTEXT_BYTES) tasks.pop();
  return fitted;
}

/**
 * Applies phone changes in the order they were made: ticks mark tasks done,
 * reschedules move them (keeping their time), focus makes a task today's most
 * important; anything else becomes a new inbox task. Changes to a task that is
 * gone or already finished are ignored.
 */
export function applyInboxItems(
  tasks: readonly BrainTaskSnapshot[],
  items: readonly InboxRelayItem[],
  today: string,
  projects: readonly BrainProjectSnapshot[] = [],
): BrainTaskSnapshot[] {
  let current = [...tasks];
  const added: InboxRelayItem[] = [];
  const ordered = [...items].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  for (const item of ordered) {
    if (!item.action) {
      added.push(item);
      continue;
    }
    const target = current.find((task) => task.id === item.taskId);
    if (!target || target.status === "done") continue;
    if (item.action === "complete") {
      current = current.map((task) => (task === target ? archiveTask(task, today) : task));
    } else if (item.action === "reschedule" && item.date) {
      const date = item.date;
      current = current.map((task) => (task === target ? scheduleTask(task, date) : task));
    } else if (item.action === "focus") {
      current = markMostImportant(current, target.id as string, today);
    }
  }
  return [...current, ...inboxItemsToTasks(added, today, Date.now(), projects)];
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
export function inboxItemsToTasks(
  items: readonly InboxRelayItem[],
  today: string,
  rankSeed = Date.now(),
  projects: readonly BrainProjectSnapshot[] = [],
): BrainTaskSnapshot[] {
  return [...items]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((item, index) => {
      const [firstLine = "", ...rest] = item.text.split("\n");
      const typed = firstLine.trim();
      const natural = parseInboxText(typed, today);
      const title = (natural?.title.trim() || typed).slice(0, 500);
      const startTime = natural?.time ?? null;
      const project = item.projectId ? projects.find((entry) => entry.id === item.projectId) : undefined;
      const task: BrainTaskSnapshot = {
        schemaVersion: 5,
        id: crypto.randomUUID(),
        title,
        status: "todo",
        // A date picked on the phone wins over one typed in the text; a time
        // alone means today; no date at all leaves it undated in the inbox.
        taskDate: item.date ?? natural?.date ?? (startTime ? today : null),
        priority: "normal",
        projectId: project?.id ?? null,
        projectName: project?.name ?? null,
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
