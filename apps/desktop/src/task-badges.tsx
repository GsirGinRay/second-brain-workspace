import { ListChecks, Repeat } from "lucide-react";
import type { BrainTaskSnapshot } from "@second-brain/brain-core";
import { recurrenceLabel } from "./recurrence-picker";

type Locale = "zh-TW" | "en";

/** Checklist items in a task body; nested `#task` lines are tasks, not items. */
export function checklistProgress(body: string | undefined): { done: number; total: number } | null {
  if (!body) return null;
  let done = 0;
  let total = 0;
  let fence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s{0,3}(`{3,}|~{3,})/.test(line)) fence = !fence;
    if (fence) continue;
    const item = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (!item || /(^|\s)#task\b/.test(item[2]!)) continue;
    total += 1;
    if (item[1] !== " ") done += 1;
  }
  return total ? { done, total } : null;
}

/** Small read-only chips for a task card: repeat rule and checklist progress. */
export function TaskBadges({ task, locale }: { task: Pick<BrainTaskSnapshot, "recurrence" | "body">; locale: Locale }) {
  const repeat = recurrenceLabel(task.recurrence, locale);
  const checklist = checklistProgress(task.body);
  if (!repeat && !checklist) return null;
  return (
    <span className="task-badges">
      {repeat && <span className="task-badge" title={repeat}><Repeat aria-hidden="true" />{repeat}</span>}
      {checklist && (
        <span
          className={`task-badge ${checklist.done === checklist.total ? "is-complete" : ""}`}
          title={locale === "zh-TW" ? `清單完成 ${checklist.done}/${checklist.total}` : `Checklist ${checklist.done}/${checklist.total}`}
        >
          <ListChecks aria-hidden="true" />{checklist.done}/{checklist.total}
        </span>
      )}
    </span>
  );
}
