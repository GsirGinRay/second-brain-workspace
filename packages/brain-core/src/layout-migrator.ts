/**
 * Preview-only vault layout migration: old Publisher-style folders → canonical
 * folders. Filenames stay the same so `[[wikilink]]` keep working. Duplicates
 * are reported, never deleted.
 */

import { isValidDateKey } from "./dates";
import {
  CANONICAL_AI_DIR,
  CANONICAL_ATTACHMENTS_DIR,
  CANONICAL_INBOX_DIR,
  CANONICAL_INBOX_FILE,
  CANONICAL_JOURNAL_DIR,
  CANONICAL_KNOWLEDGE_DIR,
  CANONICAL_PROJECTS_DIR,
  CANONICAL_TEMPLATES_DIR,
  KNOWLEDGE_CATEGORIES,
  LEGACY_ATTACHMENTS_DIR,
  LEGACY_COLLECTIONS_DIR,
  LEGACY_INBOX_DIR,
  LEGACY_INBOX_FILE,
  LEGACY_JOURNAL_DIR,
  LEGACY_PROJECTS_DIR,
  LEGACY_TEMPLATES_DIR,
  canonicalKnowledgeWriteDir,
} from "./vault-paths";

export type LayoutEntityType = "project" | "collection";

export interface LayoutFileHint {
  relativePath: string;
  entityType?: LayoutEntityType | null;
  category?: string | null;
}

export type LayoutMigrationReason =
  | "project"
  | "knowledge"
  | "journal"
  | "inbox"
  | "template"
  | "attachment"
  | "index"
  | "already-canonical"
  | "duplicate-destination"
  | "unmapped";

export interface LayoutMigrationMove {
  from: string;
  to: string;
  reason: Exclude<LayoutMigrationReason, "index" | "already-canonical" | "duplicate-destination" | "unmapped">;
}

export interface LayoutMigrationDuplicate {
  from: string;
  to: string;
  reason: "duplicate-destination";
  /** Path that already occupies (or also wants) the destination. */
  existing: string;
}

export interface LayoutMigrationKept {
  from: string;
  reason: "index" | "already-canonical" | "unmapped";
}

export interface LayoutMigrationPlan {
  moves: LayoutMigrationMove[];
  duplicates: LayoutMigrationDuplicate[];
  kept: LayoutMigrationKept[];
}

const CANONICAL_ROOTS = [
  CANONICAL_PROJECTS_DIR,
  CANONICAL_KNOWLEDGE_DIR,
  CANONICAL_JOURNAL_DIR,
  CANONICAL_INBOX_DIR,
  CANONICAL_ATTACHMENTS_DIR,
  CANONICAL_TEMPLATES_DIR,
  CANONICAL_AI_DIR,
] as const;

function normalize(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
}

function pathKey(relativePath: string): string {
  return normalize(relativePath).toLocaleLowerCase();
}

function folderEquals(left: string, right: string): boolean {
  return left.toLocaleLowerCase() === right.toLocaleLowerCase();
}

function partsOf(relativePath: string): string[] {
  return normalize(relativePath).split("/").filter(Boolean);
}

function fileNameOf(relativePath: string): string {
  const parts = partsOf(relativePath);
  return parts[parts.length - 1] ?? "";
}

function restAfterFirst(relativePath: string): string {
  return partsOf(relativePath).slice(1).join("/");
}

function joinVaultPath(...segments: string[]): string {
  return segments
    .flatMap((segment) => normalize(segment).split("/"))
    .filter(Boolean)
    .join("/");
}

function isNoisePath(relativePath: string): boolean {
  return partsOf(relativePath).some((segment) => {
    const lower = segment.toLocaleLowerCase();
    return lower === "tmp" || lower.includes("backup");
  });
}

/** Human-made indexes stay put; the working map is `.ai/INDEX.md`. */
export function isManualIndexPath(relativePath: string): boolean {
  const parts = partsOf(relativePath);
  if (parts.length === 0) return false;
  const file = parts[parts.length - 1] ?? "";
  const root = parts[0] ?? "";
  if (file.toLocaleLowerCase() === "00-index.md") return true;
  if (file.endsWith("索引.md")) return true;
  if (/^\d{2}-index$/i.test(root)) return true;
  return false;
}

function isCanonicalRoot(name: string): boolean {
  return CANONICAL_ROOTS.some((root) => folderEquals(name, root));
}

function isMarkdownFileName(name: string): boolean {
  return name.toLocaleLowerCase().endsWith(".md") && name.length > 3;
}

function numberedPrefix(name: string): string | null {
  const match = name.match(/^(\d{2})-(.+)$/);
  return match ? match[2]! : null;
}

function knowledgeFolderFromLegacyName(name: string): string | null {
  const stripped = numberedPrefix(name) ?? name;
  const lower = stripped.toLocaleLowerCase();
  if (lower.includes("faq")) return "FAQ";
  if (lower.includes("提示詞") || lower.includes("prompt")) return "提示詞";
  if (KNOWLEDGE_CATEGORIES.includes(stripped as (typeof KNOWLEDGE_CATEGORIES)[number])) {
    return stripped;
  }
  for (const category of KNOWLEDGE_CATEGORIES) {
    if (lower.includes(category.toLocaleLowerCase())) return category;
  }
  const cleaned = stripped.replace(/[\\/:*?"<>|]+/g, " ").trim().replace(/[. ]+$/g, "");
  return cleaned || null;
}

function knowledgeDirForCategory(category: string | null | undefined): string {
  return canonicalKnowledgeWriteDir(category);
}

type Proposal =
  | { kind: "move"; to: string; reason: LayoutMigrationMove["reason"] }
  | { kind: "keep"; reason: LayoutMigrationKept["reason"] };

function propose(hint: LayoutFileHint): Proposal {
  const from = normalize(hint.relativePath);
  const parts = partsOf(from);
  const root = parts[0] ?? "";
  const fileName = fileNameOf(from);

  if (!from || isNoisePath(from)) return { kind: "keep", reason: "unmapped" };
  if (folderEquals(root, CANONICAL_AI_DIR)) return { kind: "keep", reason: "already-canonical" };
  if (isManualIndexPath(from)) return { kind: "keep", reason: "index" };
  if (isCanonicalRoot(root)) return { kind: "keep", reason: "already-canonical" };
  if (!fileName || fileName === "." || fileName.includes("..")) {
    return { kind: "keep", reason: "unmapped" };
  }

  if (folderEquals(root, LEGACY_JOURNAL_DIR)) {
    if (parts.length === 2 && isMarkdownFileName(fileName)) {
      const dateKey = fileName.slice(0, -3);
      if (isValidDateKey(dateKey)) {
        return { kind: "move", to: joinVaultPath(CANONICAL_JOURNAL_DIR, fileName), reason: "journal" };
      }
    }
    return { kind: "keep", reason: "unmapped" };
  }

  if (folderEquals(root, LEGACY_INBOX_DIR)) {
    const destName = folderEquals(fileName, LEGACY_INBOX_FILE) ? CANONICAL_INBOX_FILE : fileName;
    if (!isMarkdownFileName(destName)) return { kind: "keep", reason: "unmapped" };
    return { kind: "move", to: joinVaultPath(CANONICAL_INBOX_DIR, destName), reason: "inbox" };
  }

  if (folderEquals(root, LEGACY_TEMPLATES_DIR)) {
    if (!isMarkdownFileName(fileName)) return { kind: "keep", reason: "unmapped" };
    return { kind: "move", to: joinVaultPath(CANONICAL_TEMPLATES_DIR, fileName), reason: "template" };
  }

  if (folderEquals(root, LEGACY_ATTACHMENTS_DIR)) {
    const rest = restAfterFirst(from);
    if (!rest || rest.split("/").some((segment) => segment === ".." || segment.startsWith("."))) {
      return { kind: "keep", reason: "unmapped" };
    }
    return { kind: "move", to: joinVaultPath(CANONICAL_ATTACHMENTS_DIR, rest), reason: "attachment" };
  }

  if (hint.entityType === "project" && isMarkdownFileName(fileName)) {
    return { kind: "move", to: joinVaultPath(CANONICAL_PROJECTS_DIR, fileName), reason: "project" };
  }

  if (folderEquals(root, LEGACY_PROJECTS_DIR) && hint.entityType !== "collection") {
    if (!isMarkdownFileName(fileName)) return { kind: "keep", reason: "unmapped" };
    return { kind: "move", to: joinVaultPath(CANONICAL_PROJECTS_DIR, fileName), reason: "project" };
  }

  if (folderEquals(root, LEGACY_COLLECTIONS_DIR)) {
    if (!isMarkdownFileName(fileName)) return { kind: "keep", reason: "unmapped" };
    return {
      kind: "move",
      to: joinVaultPath(knowledgeDirForCategory(hint.category), fileName),
      reason: "knowledge",
    };
  }

  const numbered = numberedPrefix(root);
  if (numbered && !folderEquals(root, LEGACY_JOURNAL_DIR) && !folderEquals(root, LEGACY_INBOX_DIR)) {
    if (!isMarkdownFileName(fileName)) return { kind: "keep", reason: "unmapped" };
    const folder = knowledgeFolderFromLegacyName(root);
    const destDir = folder
      ? joinVaultPath(CANONICAL_KNOWLEDGE_DIR, folder)
      : CANONICAL_KNOWLEDGE_DIR;
    return { kind: "move", to: joinVaultPath(destDir, fileName), reason: "knowledge" };
  }

  if (hint.entityType === "collection" && isMarkdownFileName(fileName)) {
    return {
      kind: "move",
      to: joinVaultPath(knowledgeDirForCategory(hint.category), fileName),
      reason: "knowledge",
    };
  }

  return { kind: "keep", reason: "unmapped" };
}

function samePath(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

/**
 * Build a stable preview of moves. Destinations that already exist, or that
 * more than one source would claim, become duplicates and are not moved.
 */
export function planVaultLayoutMigration(
  files: readonly LayoutFileHint[],
): LayoutMigrationPlan {
  const seen = new Set<string>();
  const hints: LayoutFileHint[] = [];
  for (const file of files) {
    const from = normalize(file.relativePath);
    const key = pathKey(from);
    if (!from || seen.has(key)) continue;
    seen.add(key);
    hints.push({ ...file, relativePath: from });
  }
  hints.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "en"));

  const occupied = new Map<string, string>();
  for (const hint of hints) occupied.set(pathKey(hint.relativePath), hint.relativePath);

  const moves: LayoutMigrationMove[] = [];
  const duplicates: LayoutMigrationDuplicate[] = [];
  const kept: LayoutMigrationKept[] = [];
  const claimed = new Map<string, string>();
  const blocked = new Set<string>();

  const markDuplicate = (from: string, to: string, existing: string) => {
    duplicates.push({
      from,
      to,
      reason: "duplicate-destination",
      existing,
    });
  };

  const demoteClaim = (destKey: string, otherFrom: string) => {
    const earlier = claimed.get(destKey);
    if (!earlier) return;
    const firstIndex = moves.findIndex((item) => samePath(item.from, earlier));
    if (firstIndex >= 0) {
      const first = moves[firstIndex]!;
      markDuplicate(first.from, first.to, otherFrom);
      moves.splice(firstIndex, 1);
    }
    claimed.delete(destKey);
    blocked.add(destKey);
  };

  for (const hint of hints) {
    const proposal = propose(hint);
    if (proposal.kind === "keep") {
      kept.push({ from: hint.relativePath, reason: proposal.reason });
      continue;
    }
    if (samePath(hint.relativePath, proposal.to)) {
      kept.push({ from: hint.relativePath, reason: "already-canonical" });
      continue;
    }
    const destKey = pathKey(proposal.to);
    const occupant = occupied.get(destKey);
    if (occupant && !samePath(occupant, hint.relativePath)) {
      markDuplicate(hint.relativePath, proposal.to, occupant);
      continue;
    }
    if (blocked.has(destKey)) {
      markDuplicate(hint.relativePath, proposal.to, proposal.to);
      continue;
    }
    const earlier = claimed.get(destKey);
    if (earlier) {
      markDuplicate(hint.relativePath, proposal.to, earlier);
      demoteClaim(destKey, hint.relativePath);
      continue;
    }
    claimed.set(destKey, hint.relativePath);
    moves.push({ from: hint.relativePath, to: proposal.to, reason: proposal.reason });
  }

  duplicates.sort((left, right) => left.from.localeCompare(right.from, "en"));
  return { moves, duplicates, kept };
}

export function layoutMigrationHasWork(plan: LayoutMigrationPlan): boolean {
  return plan.moves.length > 0 || plan.duplicates.length > 0;
}

export function hintsForLayoutMigration(
  paths: readonly string[],
  projects: readonly { sourcePath: string | null }[],
  collections: readonly { sourcePath: string | null; category: string | null }[],
): LayoutFileHint[] {
  const projectByPath = new Map<string, true>();
  for (const project of projects) {
    if (project.sourcePath) projectByPath.set(pathKey(project.sourcePath), true);
  }
  const collectionByPath = new Map<string, string | null>();
  for (const collection of collections) {
    if (collection.sourcePath) {
      collectionByPath.set(pathKey(collection.sourcePath), collection.category ?? null);
    }
  }
  return paths.map((relativePath) => {
    const key = pathKey(relativePath);
    if (projectByPath.has(key)) {
      return { relativePath, entityType: "project" as const };
    }
    if (collectionByPath.has(key)) {
      return {
        relativePath,
        entityType: "collection" as const,
        category: collectionByPath.get(key) ?? null,
      };
    }
    return { relativePath };
  });
}
