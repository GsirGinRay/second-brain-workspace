/**
 * AI work logs: the short summaries an AI appends under a task when it
 * finishes (see the write-back rules in `.ai/INSTRUCTIONS.md`).
 *
 * ```
 *   ### AI 工作紀錄 2026-10-25 10:42（Codex）
 *   - 下一步：……
 *
 *   ### AI work log 2026-10-25 10:42 (Codex)
 *   - Next: …
 * ```
 *
 * They are plain Markdown inside the task note; nothing else stores them.
 * Work that matches no task goes to `.ai/worklog/YYYY-MM.md`.
 */

import type { BrainTaskSnapshot } from "./types";

export const AI_WORKLOG_DIR = ".ai/worklog";

/** `.ai/worklog/2026-10.md` for a `YYYY-MM-DD` date key. */
export function aiWorklogPath(dateKey: string): string {
  return `${AI_WORKLOG_DIR}/${dateKey.slice(0, 7)}.md`;
}

export interface AiWorklogEntry {
  date: string;
  time: string;
  tool: string;
  /** The "next step" line, when the AI wrote one. */
  next: string | null;
}

// The rest of the heading line is kept: some tools write the whole log on one line.
const HEADING = /^\s*#{2,4}\s*(?:AI 工作紀錄|AI work log)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s*[（(]\s*([^）)]{1,40}?)\s*[）)](.*)$/i;
const NEXT = /^\s*[-*]\s*(?:下一步|Next)\s*[：:]\s*(.+?)\s*$/i;
const INLINE_NEXT = /(?:^|\s)[-*]\s*(?:下一步|Next)\s*[：:]\s*(.+?)\s*$/i;
const ANY_HEADING = /^\s*#{1,6}\s/;

/** Every work log in a task note, in the order written. */
export function parseAiWorklog(body: string | null | undefined): AiWorklogEntry[] {
  if (!body) return [];
  const entries: AiWorklogEntry[] = [];
  let current: AiWorklogEntry | null = null;
  for (const line of body.split(/\r?\n/)) {
    const heading = HEADING.exec(line);
    if (heading) {
      current = { date: heading[1]!, time: heading[2]!, tool: heading[3]!, next: INLINE_NEXT.exec(heading[4]!)?.[1] ?? null };
      entries.push(current);
      continue;
    }
    if (ANY_HEADING.test(line)) {
      current = null;
      continue;
    }
    if (current && current.next === null) {
      const next = NEXT.exec(line);
      if (next) current.next = next[1]!;
    }
  }
  return entries;
}

export interface AiHandoff extends AiWorklogEntry {
  taskTitle: string;
  sourcePath: string | null;
}

/** The newest work logs across tasks, newest first. */
export function recentAiHandoffs(
  tasks: readonly BrainTaskSnapshot[],
  limit = 5,
): AiHandoff[] {
  const handoffs: AiHandoff[] = [];
  for (const task of tasks) {
    const entries = parseAiWorklog(task.body);
    const latest = entries[entries.length - 1];
    if (!latest) continue;
    handoffs.push({ ...latest, taskTitle: task.title, sourcePath: task.sourcePath ?? null });
  }
  return handoffs
    .sort(
      (a, b) =>
        `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`) ||
        a.taskTitle.localeCompare(b.taskTitle) ||
        (a.sourcePath ?? "").localeCompare(b.sourcePath ?? ""),
    )
    .slice(0, limit);
}
