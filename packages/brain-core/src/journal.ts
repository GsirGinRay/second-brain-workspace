/**
 * Daily journal notes: one short Markdown file per calendar day.
 *
 * Path resolution lives in vault-paths.ts. This module only owns the
 * document that new writes create. Meetings can stay calendar tasks;
 * conclusions belong here. Do not auto-promote a journal into knowledge.
 */

import { isValidDateKey } from "./dates";

export const DAILY_JOURNAL_HEADINGS = [
  "今日會議",
  "結論",
  "產生的任務",
  "可升級的知識",
] as const;

export type DailyJournalHeading = (typeof DAILY_JOURNAL_HEADINGS)[number];

/** Canonical body for a new `日誌/YYYY-MM-DD.md`.
 *  Blank canvas: the date heading only. Section titles are UI hints, not pre-written. */
export function renderDailyJournalDocument(dateKey: string): string {
  if (!isValidDateKey(dateKey)) throw new Error("INVALID_JOURNAL_DATE");
  return `# ${dateKey}\r\n\r\n`;
}

/** True when the file is empty or only the date heading — show section hint chips. */
export function isBlankDailyJournal(source: string): boolean {
  const lines = source
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return true;
  return lines.length === 1 && /^#\s+\d{4}-\d{2}-\d{2}$/.test(lines[0]!);
}
