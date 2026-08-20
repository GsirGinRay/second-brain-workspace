/**
 * Prompt library ⇄ "AI Prompts+ / GPTprompt" Chrome-extension JSON bridge.
 *
 * The extension stores prompts as records { name, category, content, ... } with
 * `category` a free-form string and `[变数]/[變數]`-style placeholders in the
 * body. Its export/import JSON is:
 *
 *   { "version": "2.0.7", "exportedAt": "...", "prompts": [ ... ] }
 *
 * or a bare array of prompt records. In the Second Brain, a reusable prompt is
 * stored as a `type: collection` whose `category` starts with `提示詞/`
 * (e.g. `提示詞/投資分析`). This module converts between the two without changing
 * the durable collection format.
 */

import type { BrainCollectionSnapshot } from "./types";

export const PROMPT_ROOT_CATEGORY = "提示詞";
export const PROMPT_NAME_LIMIT = 200;
export const PROMPT_CATEGORY_LIMIT = 100;
export const PROMPT_CONTENT_LIMIT = 100_000;
export const PROMPT_COUNT_LIMIT = 1000;

export interface PluginPromptRecord {
  id?: string;
  name: string;
  category: string;
  content: string;
  createdAt?: string;
  updatedAt?: string;
  usageCount?: number;
  lastUsedAt?: string | null;
  pinned?: boolean;
  importedAt?: string;
}

function assertString(
  value: unknown,
  field: string,
  max: number,
  index: number,
): string {
  if (typeof value !== "string") {
    throw new TypeError(`Prompt ${index + 1} ${field} must be a string.`);
  }
  if (value.length > max) {
    throw new RangeError(
      `Prompt ${index + 1} ${field} exceeds ${max} characters.`,
    );
  }
  return value;
}

function sanitizeRecord(record: unknown, index: number): PluginPromptRecord {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError(`Prompt ${index + 1} must be an object.`);
  }
  const obj = record as Record<string, unknown>;
  const name = assertString(obj.name, "name", PROMPT_NAME_LIMIT, index).trim();
  const category =
    obj.category === undefined
      ? ""
      : assertString(
          obj.category,
          "category",
          PROMPT_CATEGORY_LIMIT,
          index,
        );
  const content = assertString(
    obj.content,
    "content",
    PROMPT_CONTENT_LIMIT,
    index,
  );
  if (!name) throw new TypeError(`Prompt ${index + 1} name must not be empty.`);

  const out: PluginPromptRecord = { name, category, content };
  if (typeof obj.id === "string" && obj.id) out.id = obj.id;
  if (typeof obj.createdAt === "string") out.createdAt = obj.createdAt;
  if (typeof obj.updatedAt === "string") out.updatedAt = obj.updatedAt;
  if (
    typeof obj.usageCount === "number" &&
    Number.isFinite(obj.usageCount) &&
    obj.usageCount >= 0
  ) {
    out.usageCount = Math.floor(obj.usageCount);
  }
  if (typeof obj.lastUsedAt === "string") out.lastUsedAt = obj.lastUsedAt;
  if (obj.pinned === true) out.pinned = true;
  if (typeof obj.importedAt === "string") out.importedAt = obj.importedAt;
  return out;
}

/**
 * Parse the extension export/import JSON text into normalized prompt records.
 * Accepts a bare array of prompt records or an object with a `prompts` array.
 */
export function parsePluginExport(jsonText: string): PluginPromptRecord[] {
  if (typeof jsonText !== "string") {
    throw new TypeError("Import source must be text.");
  }
  let data: unknown;
  try {
    data = JSON.parse(jsonText);
  } catch {
    throw new TypeError("Import file is not valid JSON.");
  }
  const records: unknown = Array.isArray(data)
    ? data
    : (data as { prompts?: unknown } | null)?.prompts;
  if (!Array.isArray(records)) {
    throw new TypeError("Import data must be an array.");
  }
  if (records.length > PROMPT_COUNT_LIMIT) {
    throw new RangeError(`Import cannot contain more than ${PROMPT_COUNT_LIMIT} prompts.`);
  }
  return records.map((record, index) => sanitizeRecord(record, index));
}

/** Build a plugin JSON export string (round-trips with parsePluginExport). */
export function renderPluginExport(
  prompts: PluginPromptRecord[],
  version = "2.0.7",
): string {
  return JSON.stringify(
    {
      version,
      exportedAt: new Date().toISOString(),
      prompts,
    },
    null,
    2,
  );
}

/** Map a plugin category to a collection category under the 提示詞 root. */
export function toCollectionCategory(
  pluginCategory: string,
): string {
  const trimmed = pluginCategory.trim();
  if (!trimmed) return PROMPT_ROOT_CATEGORY;
  const lowered = trimmed.toLocaleLowerCase();
  const rootPrefix = `${PROMPT_ROOT_CATEGORY.toLocaleLowerCase()}/`;
  // Already under the 提示詞 root (or equal to it) — return as-is.
  if (lowered === PROMPT_ROOT_CATEGORY.toLocaleLowerCase() || lowered.startsWith(rootPrefix)) {
    return trimmed;
  }
  return `${PROMPT_ROOT_CATEGORY}/${trimmed}`;
}

/** Convert one plugin prompt record into a collection snapshot (no id assigned). */
export function promptToCollection(
  prompt: PluginPromptRecord,
  now: () => string = () => new Date().toISOString(),
): Omit<BrainCollectionSnapshot, "id"> & { id: string | null } {
  const category = toCollectionCategory(prompt.category);
  return {
    schemaVersion: 6,
    id: prompt.id && /^[0-9a-f-]{36}$/i.test(prompt.id) ? prompt.id : null,
    name: prompt.name,
    sourcePath: null,
    category,
    importance: null,
    body: prompt.content,
  };
}

/** Convert a collection snapshot back into a plugin prompt record. */
export function collectionToPrompt(
  collection: BrainCollectionSnapshot,
  extra: {
    usageCount?: number;
    lastUsedAt?: string | null;
    pinned?: boolean;
  } = {},
): PluginPromptRecord {
  const category = collection.category ?? "";
  const trimmed = category.trim();
  // Strip the leading 提示詞/ root so the plugin sees the plain sub-category.
  const root = PROMPT_ROOT_CATEGORY.toLocaleLowerCase();
  const pluginCategory = trimmed.toLocaleLowerCase().startsWith(`${root}/`)
    ? trimmed.slice(PROMPT_ROOT_CATEGORY.length + 1).trim()
    : trimmed;
  const out: PluginPromptRecord = {
    name: collection.name,
    category: pluginCategory,
    content: collection.body,
  };
  if (collection.id) out.id = collection.id;
  if (extra.usageCount != null) out.usageCount = extra.usageCount;
  if (extra.lastUsedAt != null) out.lastUsedAt = extra.lastUsedAt;
  if (extra.pinned) out.pinned = true;
  return out;
}

const VARIABLE_RE = /\[([^\[\]()\s|]+)\](?!\()/g;

/**
 * Extract `[variable]` placeholders from a prompt body (single token inside
 * square brackets; markdown links `[text](url)` are not treated as variables).
 */
export function extractPromptVariables(content: string): string[] {
  const seen: string[] = [];
  const set = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = VARIABLE_RE.exec(content)) !== null) {
    if (!set.has(match[1]!)) {
      set.add(match[1]!);
      seen.push(match[1]!);
    }
  }
  return seen;
}

/** Replace `[variable]` placeholders with provided values; unknown stay as-is. */
export function fillPromptVariables(
  content: string,
  values: Record<string, string>,
): string {
  return content.replace(
    VARIABLE_RE,
    (match, name: string) =>
      Object.prototype.hasOwnProperty.call(values, name) ? values[name] : match,
  );
}
