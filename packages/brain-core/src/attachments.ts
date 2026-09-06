/**
 * Vault attachments live in `附件/<project or category>/<file>`.
 * Markdown stores only a relative link; binaries are never scanned as notes.
 */

import {
  CANONICAL_ATTACHMENTS_DIR,
  CANONICAL_INBOX_DIR,
  CANONICAL_JOURNAL_DIR,
  CANONICAL_KNOWLEDGE_DIR,
  CANONICAL_PROJECTS_DIR,
  canonicalKnowledgeWriteDir,
} from "./vault-paths";

export const ATTACHMENT_IMAGE_EXTENSIONS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
] as const;

export const ATTACHMENT_FILE_EXTENSIONS = [
  ...ATTACHMENT_IMAGE_EXTENSIONS,
  "pdf",
  "txt",
  "md",
  "csv",
] as const;

export const ATTACHMENT_ACCEPT = ATTACHMENT_FILE_EXTENSIONS.map(
  (ext) => `.${ext}`,
).join(",");

export const ATTACHMENT_MAX_FILE_BYTES = 16 * 1024 * 1024;

const IMAGE_SET = new Set<string>(ATTACHMENT_IMAGE_EXTENSIONS);
const ALLOWED_SET = new Set<string>(ATTACHMENT_FILE_EXTENSIONS);

const MARKDOWN_LINK = /!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^)\s]+))\s*\)/g;

export function attachmentExtension(fileName: string): string | null {
  const base = fileName.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return null;
  return base.slice(dot + 1).toLowerCase();
}

export function isAllowedAttachmentExtension(extension: string): boolean {
  return ALLOWED_SET.has(extension.trim().toLowerCase());
}

export function isImageAttachmentExtension(extension: string): boolean {
  return IMAGE_SET.has(extension.trim().toLowerCase());
}

export function isImageAttachmentPath(relativePath: string): boolean {
  const ext = attachmentExtension(relativePath);
  return ext !== null && isImageAttachmentExtension(ext);
}

export function sanitizeAttachmentFolderName(
  name: string | null | undefined,
): string {
  const cleaned = (name ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  if (!cleaned || cleaned.startsWith(".") || cleaned.includes("..")) return "";
  return cleaned.slice(0, 100);
}

export function sanitizeAttachmentFileName(name: string): string | null {
  const base = (name.replace(/\\/g, "/").split("/").pop() ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f]+/g, "")
    .trim();
  if (!base || base.startsWith(".") || base.includes("..")) return null;
  const ext = attachmentExtension(base);
  if (!ext || !isAllowedAttachmentExtension(ext)) return null;
  const dot = base.lastIndexOf(".");
  const stem = base
    .slice(0, dot)
    .replace(/[<>:"/\\|?*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  if (!stem) return null;
  return `${stem.slice(0, 120)}.${ext}`;
}

export function uniqueAttachmentFileName(
  original: string,
  existingNames: readonly string[],
): string {
  const used = new Set(existingNames.map((name) => name.toLocaleLowerCase()));
  if (!used.has(original.toLocaleLowerCase())) return original;
  const ext = attachmentExtension(original) ?? "";
  const stem = ext ? original.slice(0, original.length - ext.length - 1) : original;
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = ext ? `${stem}-${suffix}.${ext}` : `${stem}-${suffix}`;
    if (!used.has(candidate.toLocaleLowerCase())) return candidate;
  }
  throw new Error("ATTACHMENT_PATH_EXHAUSTED");
}

export function canonicalAttachmentPath(folder: string, fileName: string): string {
  return `${CANONICAL_ATTACHMENTS_DIR}/${folder}/${fileName}`;
}

export function attachmentFolderForProject(
  name: string | null | undefined,
): string {
  return sanitizeAttachmentFolderName(name) || CANONICAL_PROJECTS_DIR;
}

export function attachmentFolderForKnowledge(
  category: string | null | undefined,
): string {
  const writeDir = canonicalKnowledgeWriteDir(category);
  const parts = writeDir.split("/").filter(Boolean);
  const folder = parts.length > 1 ? parts[1] : parts[0];
  return sanitizeAttachmentFolderName(folder) || CANONICAL_KNOWLEDGE_DIR;
}

export function attachmentFolderForJournal(): string {
  return CANONICAL_JOURNAL_DIR;
}

export function attachmentFolderForTask(
  projectName: string | null | undefined,
): string {
  return projectName?.trim()
    ? attachmentFolderForProject(projectName)
    : CANONICAL_INBOX_DIR;
}

function needsMarkdownAngleBrackets(path: string): boolean {
  return /[\s()]/.test(path);
}

export function renderAttachmentMarkdown(relativePath: string): string {
  const name = relativePath.replace(/\\/g, "/").split("/").pop() ?? relativePath;
  const href = needsMarkdownAngleBrackets(relativePath)
    ? `<${relativePath}>`
    : relativePath;
  if (isImageAttachmentPath(relativePath)) return `![](${href})`;
  return `[${name}](${href})`;
}

/** Normalize a Markdown href to `附件/<folder>/<file>` or null. */
export function vaultAttachmentRelativePath(href: string): string | null {
  if (!href.trim()) return null;
  let decoded = href.trim();
  try {
    decoded = decodeURI(decoded);
  } catch {
    /* keep raw */
  }
  decoded = decoded.replace(/\\/g, "/");
  if (
    decoded.includes("://")
    || decoded.startsWith("/")
    || decoded.includes("..")
  ) {
    return null;
  }
  const parts = decoded.split("/").filter(Boolean);
  const index = parts.indexOf(CANONICAL_ATTACHMENTS_DIR);
  if (index < 0) return null;
  const rest = parts.slice(index);
  if (rest.length !== 3) return null;
  const folder = rest[1]!;
  const file = rest[2]!;
  if (!sanitizeAttachmentFolderName(folder)) return null;
  if (!sanitizeAttachmentFileName(file)) return null;
  return canonicalAttachmentPath(folder, file);
}

export function extractAttachmentHrefs(markdown: string): string[] {
  const found: string[] = [];
  const matcher = new RegExp(MARKDOWN_LINK.source, "g");
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(markdown))) {
    const path = vaultAttachmentRelativePath(match[1] ?? match[2] ?? "");
    if (path) found.push(path);
  }
  return found;
}

export function canAddAttachments(
  markdown: string,
  incomingCount: number,
  maxAttachments?: number,
): boolean {
  if (incomingCount <= 0) return false;
  if (maxAttachments === undefined) return true;
  return extractAttachmentHrefs(markdown).length + incomingCount <= maxAttachments;
}
