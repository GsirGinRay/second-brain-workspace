/**
 * Encrypted "today" snapshot for the phone (option B in docs/inbox-relay.md).
 *
 * The desktop seals a small list of tasks with a symmetric view key that it
 * shares with paired phones through the QR fragment. The relay keeps only the
 * latest sealed snapshot. The AAD binds it to the inbox and to its version so
 * the relay cannot move it to another inbox or pass off an older one as new.
 */
import { z } from "zod";
import { decodeBase64Url, encodeBase64Url, isInboxId } from "./inbox-envelope";

export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_HKDF_INFO = "second-brain-snapshot-v1";
export const SNAPSHOT_TASK_LIMIT = 300;
export const SNAPSHOT_TITLE_LIMIT = 200;
export const SNAPSHOT_BYTES_LIMIT = 128 * 1024;
const VIEW_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;

export const SNAPSHOT_STATUSES = ["todo", "doing", "waiting", "done"] as const;
export const SNAPSHOT_PRIORITIES = ["highest", "high", "medium", "normal", "low"] as const;

export interface SnapshotTask {
  id: string;
  title: string;
  date: string | null;
  time: string | null;
  durationMinutes: number | null;
  priority: (typeof SNAPSHOT_PRIORITIES)[number];
  status: (typeof SNAPSHOT_STATUSES)[number];
  project: string | null;
}

export interface InboxSnapshot {
  v: 1;
  generatedAt: string;
  /** The desktop's today (Asia/Taipei), YYYY-MM-DD. */
  today: string;
  tasks: SnapshotTask[];
}

export interface SnapshotEnvelope {
  v: 1;
  /** Strictly increasing; milliseconds since the epoch when sealed. */
  version: number;
  nonce: string;
  ct: string;
}

const taskSchema = z
  .object({
    id: z.string().min(1).max(100),
    title: z.string().min(1).max(SNAPSHOT_TITLE_LIMIT),
    date: z.string().regex(DATE).nullable(),
    time: z.string().regex(TIME).nullable(),
    durationMinutes: z.number().int().min(1).max(1440).nullable(),
    priority: z.enum(SNAPSHOT_PRIORITIES),
    status: z.enum(SNAPSHOT_STATUSES),
    project: z.string().max(200).nullable(),
  })
  .strict();

const snapshotSchema = z
  .object({
    v: z.literal(1),
    generatedAt: z.string().datetime({ offset: true }),
    today: z.string().regex(DATE),
    tasks: z.array(taskSchema).max(SNAPSHOT_TASK_LIMIT),
  })
  .strict();

const envelopeSchema = z
  .object({
    v: z.literal(1),
    version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
    ct: z.string().regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict();

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export function isViewKey(value: string): boolean {
  try {
    return /^[A-Za-z0-9_-]{43}$/.test(value) && decodeBase64Url(value).byteLength === VIEW_KEY_BYTES;
  } catch {
    return false;
  }
}

export function parseSnapshot(value: unknown): InboxSnapshot {
  return { ...snapshotSchema.parse(value), v: 1 };
}

export function parseSnapshotEnvelope(value: unknown): SnapshotEnvelope {
  return { ...envelopeSchema.parse(value), v: 1 };
}

export function snapshotAssociatedData(inboxId: string, version: number): Uint8Array<ArrayBuffer> {
  if (!isInboxId(inboxId)) throw new Error("Invalid inbox id");
  return utf8.encode(`snapshot-v${SNAPSHOT_VERSION}\n${inboxId}\n${version}`);
}

async function contentKey(viewKey: string, inboxId: string): Promise<CryptoKey> {
  if (!isViewKey(viewKey)) throw new Error("Invalid view key");
  const base = await crypto.subtle.importKey("raw", decodeBase64Url(viewKey), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: utf8.encode(inboxId), info: utf8.encode(SNAPSHOT_HKDF_INFO) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Deterministic inputs; only golden-vector tests pass them. */
export interface SealSnapshotOverrides {
  nonce: Uint8Array<ArrayBuffer>;
}

export async function sealSnapshot(
  snapshot: InboxSnapshot,
  inboxId: string,
  viewKey: string,
  version: number,
  overrides?: SealSnapshotOverrides,
): Promise<SnapshotEnvelope> {
  const plaintext = utf8.encode(JSON.stringify(parseSnapshot(snapshot)));
  const nonce = overrides?.nonce ?? crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: snapshotAssociatedData(inboxId, version) },
    await contentKey(viewKey, inboxId),
    plaintext,
  );
  const envelope: SnapshotEnvelope = {
    v: 1,
    version,
    nonce: encodeBase64Url(nonce),
    ct: encodeBase64Url(new Uint8Array(ciphertext)),
  };
  if (utf8.encode(JSON.stringify(envelope)).byteLength > SNAPSHOT_BYTES_LIMIT) {
    throw new Error("Snapshot is too large");
  }
  return envelope;
}

export async function openSnapshot(value: unknown, inboxId: string, viewKey: string): Promise<InboxSnapshot> {
  const envelope = parseSnapshotEnvelope(value);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: decodeBase64Url(envelope.nonce),
      additionalData: snapshotAssociatedData(inboxId, envelope.version),
    },
    await contentKey(viewKey, inboxId),
    decodeBase64Url(envelope.ct),
  );
  return parseSnapshot(JSON.parse(utf8Decoder.decode(new Uint8Array(plaintext))));
}
