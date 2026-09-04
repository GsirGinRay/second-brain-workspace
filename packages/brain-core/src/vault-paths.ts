/**
 * Canonical vault folder contract.
 *
 * Software writes only these relative paths. Legacy folders remain readable
 * until the migrator session. Markdown stays the long-term source of truth.
 */

export const CANONICAL_PROJECTS_DIR = "專案";
export const CANONICAL_KNOWLEDGE_DIR = "知識";
export const CANONICAL_JOURNAL_DIR = "日誌";
export const CANONICAL_INBOX_DIR = "收件匣";
export const CANONICAL_INBOX_FILE = "待辦.md";
export const CANONICAL_INBOX_PATH = `${CANONICAL_INBOX_DIR}/${CANONICAL_INBOX_FILE}`;
export const CANONICAL_ATTACHMENTS_DIR = "附件";
export const CANONICAL_TEMPLATES_DIR = "模板";
export const CANONICAL_AI_DIR = ".ai";

/** Knowledge classification folders. Category UI lands in a later session. */
export const KNOWLEDGE_CATEGORIES = [
  "FAQ",
  "產業",
  "社群",
  "影片",
  "方法",
  "提示詞",
] as const;

export type KnowledgeCategory = (typeof KNOWLEDGE_CATEGORIES)[number];

/** New collections write here until category UI exists. Frozen: not 知識/提示詞/. */
export const CANONICAL_COLLECTION_WRITE_DIR = CANONICAL_KNOWLEDGE_DIR;

export const LEGACY_PROJECTS_DIR = "Projects";
export const LEGACY_COLLECTIONS_DIR = "Collections";
export const LEGACY_INBOX_DIR = "10-收件匣";
export const LEGACY_INBOX_FILE = "待辦收件匣.md";
export const LEGACY_INBOX_PATH = `${LEGACY_INBOX_DIR}/${LEGACY_INBOX_FILE}`;
export const LEGACY_TEMPLATES_DIR = "90-模板";
export const LEGACY_JOURNAL_DIR = "05-每日工作台";

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
 * New tasks still land in the inbox this session. Prefer the canonical file;
 * keep writing the legacy inbox when it exists and the new file does not.
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
