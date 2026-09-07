/**
 * Canonical vault folder contract.
 *
 * Software writes only these relative paths. Legacy folders remain readable
 * until the migrator session. Markdown stays the long-term source of truth.
 */

import { isValidDateKey } from "./dates";

export const CANONICAL_PROJECTS_DIR = "專案";
export const CANONICAL_KNOWLEDGE_DIR = "知識";
export const CANONICAL_JOURNAL_DIR = "日誌";
export const CANONICAL_INBOX_DIR = "收件匣";
export const CANONICAL_INBOX_FILE = "待辦.md";
export const CANONICAL_INBOX_PATH = `${CANONICAL_INBOX_DIR}/${CANONICAL_INBOX_FILE}`;
export const CANONICAL_ATTACHMENTS_DIR = "附件";
export const CANONICAL_TEMPLATES_DIR = "模板";
export const CANONICAL_AI_DIR = ".ai";

/** Knowledge classification folders used by the knowledge UI and write path. */
export const KNOWLEDGE_CATEGORIES = [
  "FAQ",
  "產業",
  "社群",
  "影片",
  "方法",
  "提示詞",
] as const;

export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];

/** Fallback write dir when the category is not one of KNOWLEDGE_CATEGORIES. */
export const CANONICAL_COLLECTION_WRITE_DIR = CANONICAL_KNOWLEDGE_DIR;

function knowledgeCategoryFolder(
  category: string | null | undefined,
): KnowledgeCategory | null {
  const trimmed = (category ?? "").trim();
  if (!trimmed) return null;
  const exact = KNOWLEDGE_CATEGORIES.find((item) => item === trimmed);
  if (exact) return exact;
  const slash = trimmed.indexOf("/");
  if (slash > 0) {
    const root = trimmed.slice(0, slash);
    return KNOWLEDGE_CATEGORIES.find((item) => item === root) ?? null;
  }
  return null;
}

/** New knowledge lands in 知識/<FAQ|產業|社群|影片|方法|提示詞>/. */
export function canonicalKnowledgeWriteDir(
  category: string | null | undefined,
): string {
  const folder = knowledgeCategoryFolder(category);
  return folder ? `${CANONICAL_KNOWLEDGE_DIR}/${folder}` : CANONICAL_COLLECTION_WRITE_DIR;
}

/** Filter by a canonical root (FAQ, 提示詞, …) or an exact legacy category. */
export function collectionMatchesCategoryFilter(
  category: string | null | undefined,
  filter: string,
): boolean {
  if (filter === "all") return true;
  const trimmed = (category ?? "").trim();
  if (!trimmed) return false;
  if (trimmed === filter) return true;
  return knowledgeCategoryFolder(trimmed) === filter;
}

/** Always list the six vault categories, then leftover legacy labels. */
export function knowledgeFilterCategories(
  existing: readonly (string | null | undefined)[],
): string[] {
  const extras = new Set<string>();
  for (const cat of existing) {
    const trimmed = (cat ?? "").trim();
    if (!trimmed) continue;
    if (knowledgeCategoryFolder(trimmed) === null) extras.add(trimmed);
  }
  return [
    ...KNOWLEDGE_CATEGORIES,
    ...[...extras].sort((a, b) => a.localeCompare(b, "zh-Hant-TW")),
  ];
}

export const LEGACY_PROJECTS_DIR = "Projects";
export const LEGACY_COLLECTIONS_DIR = "Collections";
export const LEGACY_INBOX_DIR = "10-收件匣";
export const LEGACY_INBOX_FILE = "待辦收件匣.md";
export const LEGACY_INBOX_PATH = `${LEGACY_INBOX_DIR}/${LEGACY_INBOX_FILE}`;
export const LEGACY_TEMPLATES_DIR = "90-模板";
export const LEGACY_JOURNAL_DIR = "05-每日工作台";
export const LEGACY_ATTACHMENTS_DIR = "99-附件";

export const MANAGED_TEMPLATE_DIRS = [
  CANONICAL_TEMPLATES_DIR,
  LEGACY_TEMPLATES_DIR,
] as const;

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/");
}

function pathKey(relativePath: string): string {
  return normalizeRelativePath(relativePath).toLocaleLowerCase();
}

export function isContentScanExcludedDirName(name: string): boolean {
  const lower = name.toLocaleLowerCase();
  return (
    lower === CANONICAL_TEMPLATES_DIR.toLocaleLowerCase() ||
    lower === LEGACY_TEMPLATES_DIR.toLocaleLowerCase() ||
    lower === CANONICAL_ATTACHMENTS_DIR.toLocaleLowerCase() ||
    lower === "tmp" ||
    lower.includes("backup")
  );
}

/** True when a relative path sits under a folder that content scan must skip. */
export function isContentScanExcludedPath(relativePath: string): boolean {
  const parts = normalizeRelativePath(relativePath).split("/").filter(Boolean);
  if (parts.length <= 1) return false;
  return parts.slice(0, -1).some((segment) => isContentScanExcludedDirName(segment));
}

/**
 * Write path for new tasks that do not belong to a project file.
 * Prefer the canonical inbox; keep writing the legacy inbox when it exists
 * and the new file does not.
 */
export function resolveInboxWritePath(existingPaths: readonly string[]): string {
  const canonicalKey = pathKey(CANONICAL_INBOX_PATH);
  const legacyKey = pathKey(LEGACY_INBOX_PATH);
  let canonicalActual: string | undefined;
  let legacyActual: string | undefined;
  for (const path of existingPaths) {
    const key = pathKey(path);
    if (key === canonicalKey) canonicalActual = normalizeRelativePath(path);
    else if (key === legacyKey) legacyActual = normalizeRelativePath(path);
  }
  if (!canonicalActual && legacyActual) return legacyActual;
  return canonicalActual ?? CANONICAL_INBOX_PATH;
}

export function canonicalJournalPath(dateKey: string): string {
  return `${CANONICAL_JOURNAL_DIR}/${dateKey}.md`;
}

/**
 * Point at today's journal only when the file already exists.
 * Prefer `日誌/YYYY-MM-DD.md`; fall back to `05-每日工作台/YYYY-MM-DD.md`.
 * Never invent a path for a missing file.
 */
export function resolveTodayJournalPath(
  dateKey: string,
  existingPaths: readonly string[],
): string | null {
  const canonicalKey = pathKey(canonicalJournalPath(dateKey));
  const legacyKey = pathKey(`${LEGACY_JOURNAL_DIR}/${dateKey}.md`);
  let canonicalActual: string | undefined;
  let legacyActual: string | undefined;
  for (const path of existingPaths) {
    const normalized = normalizeRelativePath(path);
    if (isContentScanExcludedPath(normalized)) continue;
    const key = pathKey(normalized);
    if (key === canonicalKey) canonicalActual = normalized;
    else if (key === legacyKey) legacyActual = normalized;
  }
  return canonicalActual ?? legacyActual ?? null;
}

function journalDateFileName(relativePath: string): string | null {
  const parts = normalizeRelativePath(relativePath).split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  const [dir, file] = parts;
  if (dir !== CANONICAL_JOURNAL_DIR && dir !== LEGACY_JOURNAL_DIR) return null;
  if (!file.toLocaleLowerCase().endsWith(".md")) return null;
  const dateKey = file.slice(0, -3);
  return isValidDateKey(dateKey) ? dateKey : null;
}

/** True for `日誌/YYYY-MM-DD.md` and legacy `05-每日工作台/YYYY-MM-DD.md`. */
export function isJournalNotePath(relativePath: string): boolean {
  return journalDateFileName(relativePath) !== null;
}

export function journalNoteDateKey(relativePath: string): string | null {
  return journalDateFileName(relativePath);
}

export interface DailyJournalRef {
  relativePath: string;
  exists: boolean;
}

/**
 * Open an existing journal for `dateKey` (canonical, else legacy).
 * If neither file exists, the write path is always `日誌/YYYY-MM-DD.md`.
 */
export function resolveDailyJournal(
  dateKey: string,
  existingPaths: readonly string[],
): DailyJournalRef {
  const existing = resolveTodayJournalPath(dateKey, existingPaths);
  if (existing) return { relativePath: existing, exists: true };
  return { relativePath: canonicalJournalPath(dateKey), exists: false };
}
