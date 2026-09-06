/**
 * Save a task or journal outcome as a long-term knowledge note.
 *
 * The original inbox line or daily journal is left untouched. Knowledge
 * mentions a project with a wikilink, not a nested folder. Completing a
 * task must never create a note by itself.
 */

import { extractAttachmentHrefs, renderAttachmentMarkdown } from "./attachments";
import { isValidDateKey } from "./dates";
import { DAILY_JOURNAL_HEADINGS } from "./journal";
import type { BrainCollectionSnapshot } from "./types";

export const OUTCOME_SOURCE_DATE_PREFIX = "來源：";

const WIKILINK = /!?\[\[([^\]|#\n]+)(?:#[^\]|]*)?(?:\|[^\]]+)?\]\]/g;
const PROJECT_LABEL = /^(?:專案|project)\s*[:：]\s*(.+)$/i;

export interface OutcomeKnowledgeInput {
  title: string;
  content: string;
  sourceDate: string | null | undefined;
  /** Markdown that already has `附件/` links to reuse (task notes or the full journal). */
  attachmentSource?: string;
}

function normalizeName(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase();
}

/** Targets of `[[Name]]` / `[[Name|alias]]` / `[[Name#heading]]`. */
export function extractWikilinkTargets(markdown: string): string[] {
  const found: string[] = [];
  const matcher = new RegExp(WIKILINK.source, "g");
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(markdown))) {
    const target = match[1]!.trim();
    if (target) found.push(target);
  }
  return found;
}

export function knowledgeMentionsProject(
  collection: Pick<BrainCollectionSnapshot, "name" | "body" | "category">,
  projectName: string,
): boolean {
  const wanted = normalizeName(projectName);
  if (!wanted) return false;
  const fields = [collection.body, collection.category ?? ""];
  for (const field of fields) {
    if (extractWikilinkTargets(field).some((target) => normalizeName(target) === wanted)) {
      return true;
    }
  }
  if (normalizeName(collection.category ?? "") === wanted) return true;
  for (const line of collection.body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (normalizeName(trimmed) === wanted) return true;
    const labeled = trimmed.match(PROJECT_LABEL);
    if (labeled && normalizeName(labeled[1] ?? "") === wanted) return true;
  }
  return false;
}

export function relatedKnowledgeForProject(
  collections: readonly BrainCollectionSnapshot[],
  projectName: string,
): BrainCollectionSnapshot[] {
  const wanted = projectName.trim();
  if (!wanted) return [];
  return collections.filter((collection) => knowledgeMentionsProject(collection, wanted));
}

/** Body under `## heading` until the next same-level heading. */
export function extractMarkdownSection(source: string, heading: string): string {
  const wanted = heading.trim();
  if (!wanted) return "";
  const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${wanted}`);
  if (start < 0) return "";
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^##\s+/.test(lines[index]!)) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

function stripJournalScaffold(source: string): string {
  const headings = new Set<string>(DAILY_JOURNAL_HEADINGS);
  const kept: string[] = [];
  for (const line of source.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (/^#\s+/.test(line)) continue;
    const section = line.match(/^##\s+(.+)$/);
    if (section && headings.has(section[1]!.trim())) continue;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

/**
 * Prefer the "可升級的知識" section, then 結論, then any free-form body.
 * Empty journal templates produce an empty string.
 */
export function journalUpgradeContent(source: string): string {
  const upgrade = extractMarkdownSection(source, "可升級的知識");
  if (upgrade) return upgrade;
  const conclusion = extractMarkdownSection(source, "結論");
  if (conclusion) return conclusion;
  return stripJournalScaffold(source);
}

export function defaultJournalKnowledgeTitle(dateKey: string, content: string): string {
  const first = content
    .split(/\r?\n/)
    .map((line) => line.replace(/^#{1,6}\s*/, "").replace(/^[-*+]\s+/, "").trim())
    .find((line) => line && line !== dateKey);
  if (first && first.length <= 200) return first;
  return `${dateKey} 結論`;
}

function withSourceDate(body: string, date: string | null | undefined): string {
  if (!date || !isValidDateKey(date)) return body.replace(/\s+$/, "");
  const line = `${OUTCOME_SOURCE_DATE_PREFIX}${date}`;
  const trimmed = body.replace(/^\s+/, "").replace(/\s+$/, "");
  if (trimmed.split(/\r?\n/).some((candidate) => candidate.trim() === line)) {
    return trimmed;
  }
  return trimmed ? `${line}\n\n${trimmed}` : line;
}

function withReusedAttachments(body: string, sourceMarkdown: string): string {
  const already = new Set(extractAttachmentHrefs(body));
  const extra: string[] = [];
  for (const path of extractAttachmentHrefs(sourceMarkdown)) {
    if (already.has(path) || extra.includes(path)) continue;
    extra.push(path);
  }
  if (extra.length === 0) return body.replace(/\s+$/, "");
  const links = extra.map((path) => renderAttachmentMarkdown(path)).join("\n");
  const trimmed = body.replace(/\s+$/, "");
  return trimmed ? `${trimmed}\n\n${links}` : links;
}

/** Visible Markdown body for a new knowledge note. Does not append `[[project]]`. */
export function renderOutcomeKnowledgeBody(input: {
  content: string;
  sourceDate: string | null | undefined;
  attachmentSource?: string;
}): string {
  const withDate = withSourceDate(input.content, input.sourceDate);
  return withReusedAttachments(withDate, input.attachmentSource ?? input.content);
}

export function buildOutcomeKnowledgeDraft(input: OutcomeKnowledgeInput): {
  name: string;
  body: string;
} {
  const name = input.title.replace(/[\r\n]+/g, " ").trim() || "未命名知識";
  return {
    name: name.slice(0, 200),
    body: renderOutcomeKnowledgeBody({
      content: input.content,
      sourceDate: input.sourceDate,
      attachmentSource: input.attachmentSource,
    }),
  };
}
