/**
 * Canonical vault folder contract.
 *
 * Software writes only these relative paths. Legacy folders remain readable
 * until the migrator session. Markdown stays the long-term source of truth.
 *
 * Content folders follow the language the vault was created in: a vault made
 * in Traditional Chinese uses 收件匣/專案/…, one made in English uses
 * Inbox/Projects/…. The loader detects the layout from the folders that exist
 * and activates it before anything resolves a write path.
 */

import { isValidDateKey } from "./dates";

export type VaultLocale = "zh-TW" | "en";

export interface VaultLayout {
  readonly locale: VaultLocale;
  readonly projectsDir: string;
  readonly knowledgeDir: string;
  readonly journalDir: string;
  readonly inboxDir: string;
  readonly inboxFile: string;
  readonly attachmentsDir: string;
  readonly templatesDir: string;
  /** Knowledge categories that get their own folder under knowledgeDir. */
  readonly knowledgeCategories: readonly string[];
  /** Category root for reusable prompts, e.g. `提示詞/會議紀錄`. */
  readonly promptsCategory: string;
}

export const ZH_TW_VAULT_LAYOUT: VaultLayout = {
  locale: "zh-TW",
  projectsDir: "專案",
  knowledgeDir: "知識",
  journalDir: "日誌",
  inboxDir: "收件匣",
  inboxFile: "待辦.md",
  attachmentsDir: "附件",
  templatesDir: "模板",
  knowledgeCategories: ["FAQ", "產業", "社群", "影片", "方法", "提示詞"],
  promptsCategory: "提示詞",
};

export const EN_VAULT_LAYOUT: VaultLayout = {
  locale: "en",
  projectsDir: "Projects",
  knowledgeDir: "Knowledge",
  journalDir: "Journal",
  inboxDir: "Inbox",
  inboxFile: "Inbox.md",
  attachmentsDir: "Attachments",
  templatesDir: "Templates",
  knowledgeCategories: ["FAQ", "Prompts"],
  promptsCategory: "Prompts",
};

export function vaultLayoutFor(locale: VaultLocale): VaultLayout {
  return locale === "en" ? EN_VAULT_LAYOUT : ZH_TW_VAULT_LAYOUT;
}

let activeLayout: VaultLayout = ZH_TW_VAULT_LAYOUT;

/** The layout of the vault that is open now. */
export function activeVaultLayout(): VaultLayout {
  return activeLayout;
}

export function setActiveVaultLayout(layout: VaultLayout): void {
  activeLayout = layout;
}

export function activeInboxPath(): string {
  return `${activeLayout.inboxDir}/${activeLayout.inboxFile}`;
}

const ZH_TW_MARKERS = ["收件匣", "專案", "知識", "日誌", "附件", "模板", "10-收件匣", "05-每日工作台", "90-模板", "99-附件", "collections"];
const EN_MARKERS = ["inbox", "knowledge", "journal", "attachments", "templates"];

/**
 * Pick the layout from the top-level folders that already exist. Any Chinese
 * or legacy Publisher folder means the Chinese layout (legacy `Projects/` is
 * migrated into 專案/); otherwise an English folder means English. An empty
 * vault takes the interface language.
 */
export function detectVaultLocale(
  existingPaths: readonly string[],
  fallback: VaultLocale,
): VaultLocale {
  const roots = new Set<string>();
  for (const path of existingPaths) {
    const parts = normalizeRelativePath(path).split("/").filter(Boolean);
    if (parts.length > 1) roots.add(parts[0]!.toLocaleLowerCase());
  }
  if (ZH_TW_MARKERS.some((name) => roots.has(name))) return "zh-TW";
  if (EN_MARKERS.some((name) => roots.has(name))) return "en";
  return fallback;
}

/** Chinese canonical names; kept for callers and the zh-TW legacy migrator. */
export const CANONICAL_PROJECTS_DIR = ZH_TW_VAULT_LAYOUT.projectsDir;
export const CANONICAL_KNOWLEDGE_DIR = ZH_TW_VAULT_LAYOUT.knowledgeDir;
export const CANONICAL_JOURNAL_DIR = ZH_TW_VAULT_LAYOUT.journalDir;
export const CANONICAL_INBOX_DIR = ZH_TW_VAULT_LAYOUT.inboxDir;
export const CANONICAL_INBOX_FILE = ZH_TW_VAULT_LAYOUT.inboxFile;
export const CANONICAL_INBOX_PATH = `${CANONICAL_INBOX_DIR}/${CANONICAL_INBOX_FILE}`;
export const CANONICAL_ATTACHMENTS_DIR = ZH_TW_VAULT_LAYOUT.attachmentsDir;
export const CANONICAL_TEMPLATES_DIR = ZH_TW_VAULT_LAYOUT.templatesDir;
export const CANONICAL_AI_DIR = ".ai";

/** zh-TW knowledge classification folders (the open vault may use others). */
export const KNOWLEDGE_CATEGORIES = ZH_TW_VAULT_LAYOUT.knowledgeCategories;

export type KnowledgeCategory = string;

/** zh-TW fallback write dir; see canonicalKnowledgeWriteDir for the open vault. */
export const CANONICAL_COLLECTION_WRITE_DIR = CANONICAL_KNOWLEDGE_DIR;

function knowledgeCategoryFolder(
  category: string | null | undefined,
): KnowledgeCategory | null {
  const categories = activeLayout.knowledgeCategories;
  const trimmed = (category ?? "").trim();
  if (!trimmed) return null;
  const exact = categories.find((item) => item === trimmed);
  if (exact) return exact;
  const slash = trimmed.indexOf("/");
  if (slash > 0) {
    const root = trimmed.slice(0, slash);
    return categories.find((item) => item === root) ?? null;
  }
  return null;
}

/** New knowledge lands in 知識/<category>/ (Knowledge/<category>/ in English vaults). */
export function canonicalKnowledgeWriteDir(
  category: string | null | undefined,
): string {
  const folder = knowledgeCategoryFolder(category);
  return folder ? `${activeLayout.knowledgeDir}/${folder}` : activeLayout.knowledgeDir;
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

/** Categories the vault already uses. Do not invent FAQ/產業/… before the user does. */
export function knowledgeFilterCategories(
  existing: readonly (string | null | undefined)[],
): string[] {
  const seen = new Set<string>();
  for (const cat of existing) {
    const trimmed = (cat ?? "").trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen].sort((a, b) => a.localeCompare(b, "zh-Hant-TW"));
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

/** Template folders of the open vault, including the legacy one. */
export function managedTemplateDirs(): string[] {
  return [...new Set([activeLayout.templatesDir, CANONICAL_TEMPLATES_DIR, LEGACY_TEMPLATES_DIR])];
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/");
}

function pathKey(relativePath: string): string {
  return normalizeRelativePath(relativePath).toLocaleLowerCase();
}

export function isContentScanExcludedDirName(name: string): boolean {
  const lower = name.toLocaleLowerCase();
  return (
    lower === activeLayout.templatesDir.toLocaleLowerCase() ||
    lower === activeLayout.attachmentsDir.toLocaleLowerCase() ||
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
  const inboxPath = activeInboxPath();
  const canonicalKey = pathKey(inboxPath);
  const legacyKey = pathKey(LEGACY_INBOX_PATH);
  let canonicalActual: string | undefined;
  let legacyActual: string | undefined;
  for (const path of existingPaths) {
    const key = pathKey(path);
    if (key === canonicalKey) canonicalActual = normalizeRelativePath(path);
    else if (key === legacyKey) legacyActual = normalizeRelativePath(path);
  }
  if (!canonicalActual && legacyActual) return legacyActual;
  return canonicalActual ?? inboxPath;
}

export function canonicalJournalPath(dateKey: string): string {
  return `${activeLayout.journalDir}/${dateKey}.md`;
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
  if (dir !== activeLayout.journalDir && dir !== CANONICAL_JOURNAL_DIR && dir !== LEGACY_JOURNAL_DIR) return null;
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
