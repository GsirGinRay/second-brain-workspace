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
  type InboxEnvelope,
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
  /** Set for a tick in the "today" list. */
  completes?: string;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PAIRING_KEY = "second-brain.capture.pairing";
const OUTBOX_KEY = "second-brain.capture.outbox";
const SNAPSHOT_KEY = "second-brain.capture.snapshot";
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
    return Array.isArray(value) ? (value as OutboxEntry[]) : [];
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

/** Seals the text right away; the plaintext stays on this phone only. */
export async function createEntry(pairing: Pairing, text: string, now = new Date()): Promise<OutboxEntry> {
  const id = crypto.randomUUID();
  const createdAt = now.toISOString();
  const envelope = await sealInboxItem({
    recipientPublicKey: pairing.publicKey,
    inboxId: pairing.inboxId,
    itemId: id,
    payload: { v: 1, text, createdAt, source: "pwa" },
  });
  return { id, text: text.trim(), createdAt, state: "queued", envelope };
}

/** A tick in the "today" list: marks the task done on the computer. */
export async function createCompleteEntry(
  pairing: Pairing,
  task: Pick<SnapshotTask, "id" | "title">,
  now = new Date(),
): Promise<OutboxEntry> {
  const id = crypto.randomUUID();
  const createdAt = now.toISOString();
  const envelope = await sealInboxItem({
    recipientPublicKey: pairing.publicKey,
    inboxId: pairing.inboxId,
    itemId: id,
    payload: { v: 1, text: task.title, createdAt, source: "pwa", action: "complete", taskId: task.id },
  });
  return { id, text: task.title, createdAt, state: "queued", envelope, completes: task.id };
}

/** After pairing again, unsent items are sealed for the new inbox key. */
export async function resealQueued(pairing: Pairing, entries: readonly OutboxEntry[]): Promise<OutboxEntry[]> {
  return Promise.all(entries.map(async (entry) => {
    if (entry.state !== "queued") return entry;
    const envelope = await sealInboxItem({
      recipientPublicKey: pairing.publicKey,
      inboxId: pairing.inboxId,
      itemId: entry.id,
      payload: entry.completes
        ? { v: 1, text: entry.text, createdAt: entry.createdAt, source: "pwa", action: "complete", taskId: entry.completes }
        : { v: 1, text: entry.text, createdAt: entry.createdAt, source: "pwa" },
    });
    return { ...entry, envelope };
  }));
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
): Promise<FlushOutcome> {
  const next = entries.map((entry) => ({ ...entry }));
  let sent = 0;
  for (const entry of next) {
    if (entry.state !== "queued") continue;
    const result = await upload(origin, pairing, entry, fetcher);
    if (result === "sent") {
      entry.state = "sent";
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

export interface TodayGroups {
  /** The most important open task today, shown on top. */
  focus: SnapshotTask | null;
  overdue: SnapshotTask[];
  today: SnapshotTask[];
  upcoming: { date: string; tasks: SnapshotTask[] }[];
}

/** Groups a snapshot for display, leaving out tasks ticked on this phone. */
export function groupSnapshot(snapshot: InboxSnapshot, ticked: ReadonlySet<string>): TodayGroups {
  const open = snapshot.tasks.filter((task) => task.status !== "done" && !ticked.has(task.id));
  const todayTasks = open.filter((task) => task.date === snapshot.today);
  const focus = todayTasks.find((task) => task.priority === "highest") ?? null;
  const upcoming = new Map<string, SnapshotTask[]>();
  for (const task of open) {
    if (task.date && task.date > snapshot.today) upcoming.set(task.date, [...(upcoming.get(task.date) ?? []), task]);
  }
  return {
    focus,
    overdue: open.filter((task) => task.date !== null && task.date < snapshot.today),
    today: todayTasks.filter((task) => task !== focus),
    upcoming: [...upcoming.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, tasks]) => ({ date, tasks })),
  };
}
