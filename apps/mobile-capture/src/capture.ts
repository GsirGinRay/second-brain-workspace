/**
 * Phone capture: pairing from the QR fragment, a local outbox, and upload to
 * the inbox relay. Items are sealed before they are queued, so only the
 * envelope ever leaves the phone. Protocol: docs/inbox-relay.md.
 */
import {
  INBOX_TEXT_BYTES_LIMIT,
  decodeBase64Url,
  isInboxId,
  isViewKey,
  openSnapshot,
  sealInboxItem,
  type InboxAction,
  type InboxEnvelope,
  type InboxPayload,
  type InboxSnapshot,
  type SnapshotTask,
} from "@second-brain/brain-core";

export interface Pairing {
  inboxId: string;
  token: string;
  publicKey: string;
  /** Opens the "today" snapshot; QR codes from desktop 0.8.0 and later carry it. */
  viewKey?: string;
}

export type OutboxState = "queued" | "sent" | "failed";

export interface OutboxEntry {
  id: string;
  text: string;
  createdAt: string;
  state: OutboxState;
  envelope: InboxEnvelope;
  /** A change to a task in the "today" list. */
  action?: InboxAction;
  taskId?: string;
  /** The new date of a reschedule, or the date picked for a new task. */
  date?: string;
  /** The project picked for a new task. */
  projectId?: string;
  /** Not sent before this time (ms since the epoch), so it can still be undone. */
  holdUntil?: number;
}

/** Outbox entries written by 0.8.0, when ticks were the only change. */
interface LegacyOutboxEntry extends OutboxEntry {
  completes?: string;
}

/** How long a change in the "today" list can be undone before it is sent. */
export const UNDO_MS = 5_000;

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PAIRING_KEY = "second-brain.capture.pairing";
const OUTBOX_KEY = "second-brain.capture.outbox";
const SNAPSHOT_KEY = "second-brain.capture.snapshot";
const VIEW_KEY = "second-brain.capture.view";
/** Sent items shown in the history list; queued items are never dropped. */
const SENT_HISTORY = 20;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

const utf8 = new TextEncoder();

export function textBytes(text: string): number {
  return utf8.encode(text.trim()).byteLength;
}

export function isTextWithinLimit(text: string): boolean {
  const bytes = textBytes(text);
  return bytes > 0 && bytes <= INBOX_TEXT_BYTES_LIMIT;
}

/** Reads `#v=1&i=…&t=…&k=…` from the pairing QR code; null when absent or invalid. */
export function parsePairingFragment(hash: string): Pairing | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const inboxId = params.get("i") ?? "";
  const token = params.get("t") ?? "";
  const publicKey = params.get("k") ?? "";
  const viewKey = params.get("s");
  if (params.get("v") !== "1" || !isInboxId(inboxId) || !TOKEN_PATTERN.test(token)) return null;
  if (viewKey !== null && !isViewKey(viewKey)) return null;
  try {
    const key = decodeBase64Url(publicKey);
    if (key.byteLength !== 65 || key[0] !== 0x04) return null;
  } catch {
    return null;
  }
  return viewKey ? { inboxId, token, publicKey, viewKey } : { inboxId, token, publicKey };
}

export function pairingFragment(pairing: Pairing): string {
  const view = pairing.viewKey ? `&s=${pairing.viewKey}` : "";
  return `#v=1&i=${pairing.inboxId}&t=${pairing.token}&k=${pairing.publicKey}${view}`;
}

export function loadPairing(store: KeyValueStore): Pairing | null {
  try {
    const value = JSON.parse(store.getItem(PAIRING_KEY) ?? "null") as Partial<Pairing> | null;
    if (!value) return null;
    return parsePairingFragment(pairingFragment(value as Pairing));
  } catch {
    return null;
  }
}

export function savePairing(store: KeyValueStore, pairing: Pairing): void {
  store.setItem(PAIRING_KEY, JSON.stringify(pairing));
}

export function clearPairing(store: KeyValueStore): void {
  store.removeItem(PAIRING_KEY);
}

export function loadOutbox(store: KeyValueStore): OutboxEntry[] {
  try {
    const value = JSON.parse(store.getItem(OUTBOX_KEY) ?? "[]") as unknown;
    if (!Array.isArray(value)) return [];
    return (value as LegacyOutboxEntry[]).map(({ completes, ...entry }) =>
      completes && !entry.action ? { ...entry, action: "complete", taskId: completes } : entry);
  } catch {
    return [];
  }
}

export function saveOutbox(store: KeyValueStore, entries: readonly OutboxEntry[]): void {
  const queued = entries.filter((entry) => entry.state !== "sent");
  const sent = entries.filter((entry) => entry.state === "sent").slice(-SENT_HISTORY);
  const kept = new Set([...queued, ...sent]);
  store.setItem(OUTBOX_KEY, JSON.stringify(entries.filter((entry) => kept.has(entry))));
}

type EntryFields = Omit<OutboxEntry, "state" | "envelope" | "holdUntil">;

function entryPayload(entry: EntryFields): InboxPayload {
  return {
    v: 1,
    text: entry.text,
    createdAt: entry.createdAt,
    source: "pwa",
    ...(entry.action ? { action: entry.action, taskId: entry.taskId } : {}),
    ...(entry.date ? { date: entry.date } : {}),
    ...(entry.projectId ? { projectId: entry.projectId } : {}),
  };
}

async function seal(pairing: Pairing, fields: EntryFields): Promise<InboxEnvelope> {
  return sealInboxItem({
    recipientPublicKey: pairing.publicKey,
    inboxId: pairing.inboxId,
    itemId: fields.id,
    payload: entryPayload(fields),
  });
}

export interface NewTaskOptions {
  /** YYYY-MM-DD picked on the phone; wins over a date typed in the text. */
  date?: string;
  projectId?: string;
}

/** Seals the text right away; the plaintext stays on this phone only. */
export async function createEntry(
  pairing: Pairing,
  text: string,
  now = new Date(),
  options: NewTaskOptions = {},
): Promise<OutboxEntry> {
  const fields: EntryFields = {
    id: crypto.randomUUID(),
    text: text.trim(),
    createdAt: now.toISOString(),
    ...(options.date ? { date: options.date } : {}),
    ...(options.projectId ? { projectId: options.projectId } : {}),
  };
  return { ...fields, state: "queued", envelope: await seal(pairing, fields) };
}

export interface TaskChange {
  action: InboxAction;
  /** Required for `reschedule`. */
  date?: string;
}

/**
 * A change in the "today" list: tick, reschedule or focus. It waits `holdMs`
 * before it is sent so the toast can undo it.
 */
export async function createChangeEntry(
  pairing: Pairing,
  task: Pick<SnapshotTask, "id" | "title">,
  change: TaskChange,
  now = new Date(),
  holdMs = UNDO_MS,
): Promise<OutboxEntry> {
  const fields: EntryFields = {
    id: crypto.randomUUID(),
    text: task.title,
    createdAt: now.toISOString(),
    action: change.action,
    taskId: task.id,
    ...(change.action === "reschedule" && change.date ? { date: change.date } : {}),
  };
  const entry: OutboxEntry = { ...fields, state: "queued", envelope: await seal(pairing, fields) };
  return holdMs > 0 ? { ...entry, holdUntil: now.getTime() + holdMs } : entry;
}

/** After pairing again, unsent items are sealed for the new inbox key. */
export async function resealQueued(pairing: Pairing, entries: readonly OutboxEntry[]): Promise<OutboxEntry[]> {
  return Promise.all(entries.map(async (entry) =>
    entry.state === "queued" ? { ...entry, envelope: await seal(pairing, entry) } : entry));
}

export type UploadResult ="sent" | "retry" | "unpaired" | "failed";

/** How one HTTP status maps onto the outbox. */
export function classifyStatus(status: number): UploadResult {
  if (status === 200 || status === 201) return "sent";
  if (status === 401 || status === 404) return "unpaired";
  if (status === 400 || status === 409 || status === 413) return "failed";
  return "retry";
}

export type Fetcher = (url: string, init: RequestInit) => Promise<{ status: number }>;

export async function upload(origin: string, pairing: Pairing, entry: OutboxEntry, fetcher: Fetcher): Promise<UploadResult> {
  try {
    const response = await fetcher(`${origin}/v1/inboxes/${pairing.inboxId}/items`, {
      method: "POST",
      headers: { authorization: `Bearer ${pairing.token}`, "content-type": "application/json" },
      body: JSON.stringify(entry.envelope),
      credentials: "omit",
      cache: "no-store",
    });
    return classifyStatus(response.status);
  } catch {
    return "retry";
  }
}

export interface FlushOutcome {
  entries: OutboxEntry[];
  unpaired: boolean;
  sent: number;
}

/**
 * Sends queued entries oldest first. Stops at the first entry that has to be
 * retried, so the relay keeps receiving them in order.
 */
export async function flushOutbox(
  origin: string,
  pairing: Pairing,
  entries: readonly OutboxEntry[],
  fetcher: Fetcher,
  now = Date.now(),
): Promise<FlushOutcome> {
  const next = entries.map((entry) => ({ ...entry }));
  let sent = 0;
  for (const entry of next) {
    if (entry.state !== "queued") continue;
    // Still inside its undo window; sent on a later flush.
    if (entry.holdUntil !== undefined && entry.holdUntil > now) continue;
    const result = await upload(origin, pairing, entry, fetcher);
    if (result === "sent") {
      entry.state = "sent";
      delete entry.holdUntil;
      sent += 1;
    } else if (result === "failed") {
      entry.state = "failed";
    } else {
      return { entries: next, unpaired: result === "unpaired", sent };
    }
  }
  return { entries: next, unpaired: false, sent };
}

export type SnapshotResult =
  | { kind: "ok"; snapshot: InboxSnapshot; version: number }
  | { kind: "not_entitled" }
  | { kind: "none" }
  | { kind: "unpaired" }
  | { kind: "error" };

export interface CachedSnapshot {
  inboxId: string;
  version: number;
  snapshot: InboxSnapshot;
}

export function loadCachedSnapshot(store: KeyValueStore, pairing: Pairing): CachedSnapshot | null {
  try {
    const value = JSON.parse(store.getItem(SNAPSHOT_KEY) ?? "null") as CachedSnapshot | null;
    return value && value.inboxId === pairing.inboxId ? value : null;
  } catch {
    return null;
  }
}

export function saveCachedSnapshot(store: KeyValueStore, cached: CachedSnapshot | null): void {
  if (cached) store.setItem(SNAPSHOT_KEY, JSON.stringify(cached));
  else store.removeItem(SNAPSHOT_KEY);
}

/** Downloads and opens the "today" snapshot with the pairing's view key. */
export type JsonFetcher = (url: string, init: RequestInit) => Promise<{ status: number; json(): Promise<unknown> }>;

export async function fetchSnapshot(origin: string, pairing: Pairing, fetcher: JsonFetcher): Promise<SnapshotResult> {
  if (!pairing.viewKey) return { kind: "error" };
  let response: { status: number; json(): Promise<unknown> };
  try {
    response = await fetcher(`${origin}/v1/inboxes/${pairing.inboxId}/snapshot`, {
      method: "GET",
      headers: { authorization: `Bearer ${pairing.token}` },
      credentials: "omit",
      cache: "no-store",
    });
  } catch {
    return { kind: "error" };
  }
  if (response.status === 401) return { kind: "unpaired" };
  if (response.status === 403) return { kind: "not_entitled" };
  if (response.status === 404) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    return body?.error === "no_snapshot" ? { kind: "none" } : { kind: "unpaired" };
  }
  if (response.status !== 200) return { kind: "error" };
  try {
    const envelope = await response.json() as { version: number };
    const snapshot = await openSnapshot(envelope, pairing.inboxId, pairing.viewKey);
    return { kind: "ok", snapshot, version: envelope.version };
  } catch {
    return { kind: "error" };
  }
}

export function dateKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** The Monday after `date` (a week later when `date` is a Monday). */
export function nextMonday(date: string): string {
  const weekday = new Date(`${date}T00:00:00.000Z`).getUTCDay();
  return addDays(date, ((8 - weekday) % 7) || 7);
}

/**
 * The phone's today: the computer's, unless the snapshot is from an earlier
 * day (the computer has been off overnight).
 */
export function effectiveToday(snapshot: InboxSnapshot, now = new Date()): string {
  const local = dateKey(now);
  return local > snapshot.today ? local : snapshot.today;
}

export interface LocalView {
  snapshot: InboxSnapshot;
  /** Tasks changed on this phone that the computer has not applied yet. */
  pending: ReadonlySet<string>;
  /** Of those, tasks ticked that were due by today, for the progress. */
  doneLocally: number;
}

/**
 * Shows changes made on this phone right away. A change counts until the
 * computer publishes a snapshot newer than it, which already includes it.
 * Failed entries never reached the computer and are left out.
 */
export function applyLocalChanges(snapshot: InboxSnapshot, entries: readonly OutboxEntry[], today = snapshot.today): LocalView {
  const generated = Date.parse(snapshot.generatedAt);
  const tasks = snapshot.tasks.map((task) => ({ ...task }));
  const pending = new Set<string>();
  let doneLocally = 0;
  const changes = entries
    .filter((entry) => entry.action && entry.taskId && entry.state !== "failed" && Date.parse(entry.createdAt) > generated)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  for (const change of changes) {
    const target = tasks.find((task) => task.id === change.taskId);
    if (!target || target.status === "done") continue;
    pending.add(target.id);
    if (change.action === "complete") {
      if (target.date !== null && target.date <= today) doneLocally += 1;
      target.status = "done";
    } else if (change.action === "reschedule" && change.date) {
      target.date = change.date;
    } else if (change.action === "focus") {
      for (const task of tasks) {
        if (task !== target && task.date === today && task.priority === "highest") task.priority = "high";
      }
      target.priority = "highest";
      target.date = today;
    }
  }
  return { snapshot: { ...snapshot, tasks }, pending, doneLocally };
}

export interface ViewOptions {
  /** Days after today to show: 3 or 7. */
  days: 3 | 7;
  /** Only this project's tasks, by name; null for all. */
  project: string | null;
}

export const DEFAULT_VIEW: ViewOptions = { days: 3, project: null };

export function loadView(store: KeyValueStore): ViewOptions {
  try {
    const value = JSON.parse(store.getItem(VIEW_KEY) ?? "null") as Partial<ViewOptions> | null;
    return {
      days: value?.days === 7 ? 7 : 3,
      project: typeof value?.project === "string" && value.project !== "" ? value.project : null,
    };
  } catch {
    return DEFAULT_VIEW;
  }
}

export function saveView(store: KeyValueStore, view: ViewOptions): void {
  store.setItem(VIEW_KEY, JSON.stringify(view));
}

export interface TodayGroups {
  /** The most important open task today, shown on top. */
  focus: SnapshotTask | null;
  overdue: SnapshotTask[];
  /** Today's timeline: timed tasks by start time, then the rest. */
  today: SnapshotTask[];
  upcoming: { date: string; tasks: SnapshotTask[] }[];
}

/** Groups a snapshot for display: open tasks only, within the chosen days and project. */
export function groupSnapshot(snapshot: InboxSnapshot, view: ViewOptions = DEFAULT_VIEW, today = snapshot.today): TodayGroups {
  const last = addDays(today, view.days);
  const open = snapshot.tasks.filter((task) =>
    task.status !== "done" && (view.project === null || task.project === view.project));
  const todayTasks = open
    .filter((task) => task.date === today)
    .map((task, index) => ({ task, index }))
    .sort((left, right) =>
      (left.task.time ?? "99:99").localeCompare(right.task.time ?? "99:99") || left.index - right.index)
    .map(({ task }) => task);
  const focus = todayTasks.find((task) => task.priority === "highest") ?? null;
  const upcoming = new Map<string, SnapshotTask[]>();
  for (const task of open) {
    if (task.date && task.date > today && task.date <= last) {
      upcoming.set(task.date, [...(upcoming.get(task.date) ?? []), task]);
    }
  }
  return {
    focus,
    overdue: open.filter((task) => task.date !== null && task.date < today),
    today: todayTasks.filter((task) => task !== focus),
    upcoming: [...upcoming.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, tasks]) => ({ date, tasks })),
  };
}

export interface TodayProgress {
  done: number;
  total: number;
}

/**
 * Finished today against everything that was due by today. The computer's
 * count only holds while its snapshot is from today.
 */
export function todayProgress(view: LocalView, today = view.snapshot.today): TodayProgress {
  const doneOnComputer = view.snapshot.today === today ? (view.snapshot.doneToday ?? 0) : 0;
  const done = doneOnComputer + view.doneLocally;
  const open = view.snapshot.tasks.filter((task) => task.status !== "done" && task.date !== null && task.date <= today).length;
  return { done, total: done + open };
}

/** The end of a timed task, e.g. "15:30" for 15:00 and 30 minutes. */
export function endTime(time: string, minutes: number): string {
  const [hours = 0, mins = 0] = time.split(":").map(Number);
  const total = (hours * 60 + mins + minutes) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}
