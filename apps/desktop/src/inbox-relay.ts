/**
 * Phone inbox: items the native side received and decrypted from the relay
 * (docs/inbox-relay.md) become inbox tasks, parsed like a quick add.
 */
import { isInboxItemId, rankForIndex, type BrainTaskSnapshot, type InboxSource } from "@second-brain/brain-core";
import { parseNaturalDate } from "./natural-date";

export interface InboxRelayItem {
  id: string;
  text: string;
  createdAt: string;
  source: InboxSource;
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
    || !/^https?:\/\/[^/#?]+\/#v=1&i=[A-Za-z0-9_-]{22}&t=[A-Za-z0-9_-]+&k=[A-Za-z0-9_-]+$/.test(input.url)
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
    ) {
      throw new Error("Invalid inbox relay item");
    }
    return { id: input.id, text: input.text, createdAt: input.createdAt, source: input.source as InboxSource };
  });
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
