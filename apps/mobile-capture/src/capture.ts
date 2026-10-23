/**
 * Phone capture: pairing from the QR fragment, a local outbox, and upload to
 * the inbox relay. Items are sealed before they are queued, so only the
 * envelope ever leaves the phone. Protocol: docs/inbox-relay.md.
 */
import {
  INBOX_TEXT_BYTES_LIMIT,
  decodeBase64Url,
  isInboxId,
  sealInboxItem,
  type InboxEnvelope,
} from "@second-brain/brain-core";

export interface Pairing {
  inboxId: string;
  token: string;
  publicKey: string;
}

export type OutboxState = "queued" | "sent" | "failed";

export interface OutboxEntry {
  id: string;
  text: string;
  createdAt: string;
  state: OutboxState;
  envelope: InboxEnvelope;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PAIRING_KEY = "second-brain.capture.pairing";
const OUTBOX_KEY = "second-brain.capture.outbox";
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
  if (params.get("v") !== "1" || !isInboxId(inboxId) || !TOKEN_PATTERN.test(token)) return null;
  try {
    const key = decodeBase64Url(publicKey);
    if (key.byteLength !== 65 || key[0] !== 0x04) return null;
  } catch {
    return null;
  }
  return { inboxId, token, publicKey };
}

export function loadPairing(store: KeyValueStore): Pairing | null {
  try {
    const value = JSON.parse(store.getItem(PAIRING_KEY) ?? "null") as Partial<Pairing> | null;
    if (!value) return null;
    return parsePairingFragment(`v=1&i=${value.inboxId}&t=${value.token}&k=${value.publicKey}`);
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

/** After pairing again, unsent items are sealed for the new inbox key. */
export async function resealQueued(pairing: Pairing, entries: readonly OutboxEntry[]): Promise<OutboxEntry[]> {
  return Promise.all(entries.map(async (entry) => {
    if (entry.state !== "queued") return entry;
    const envelope = await sealInboxItem({
      recipientPublicKey: pairing.publicKey,
      inboxId: pairing.inboxId,
      itemId: entry.id,
      payload: { v: 1, text: entry.text, createdAt: entry.createdAt, source: "pwa" },
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
