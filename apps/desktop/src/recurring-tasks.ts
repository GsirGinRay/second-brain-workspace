import { nextOccurrence, parseRecurrence, type BrainProjectSnapshot, type BrainTaskSnapshot } from "@second-brain/brain-core";

const MAX_CATCH_UP_STEPS = 1000;
const BLOCK_ID = /\s+\^[A-Za-z0-9][\w-]*(?=\s|$)/g;

/** Unchecks every checklist item so the next occurrence starts fresh. Sub-task lines keep their state. */
export function resetChecklist(body: string): string {
  return body.replace(/^(\s*[-*+]\s+\[)[xX](\].*)$/gm, (line, head: string, tail: string) =>
    /(^|\s)#task\b/.test(tail) ? line : `${head} ${tail}`);
}

/**
 * The date of the occurrence after `task`. An overdue repeating task skips
 * the occurrences that are already in the past instead of piling them up.
 */
export function nextRecurringDate(task: BrainTaskSnapshot, today: string): string | null {
  const rule = task.recurrence ? parseRecurrence(task.recurrence) : null;
  if (!rule) return null;
  let next = nextOccurrence(rule, task.taskDate ?? today);
  for (let step = 0; next < today && step < MAX_CATCH_UP_STEPS; step += 1) {
    next = nextOccurrence(rule, next);
  }
  return next;
}

/** Projects that are finished or archived: their tasks are closed in bulk, not completed one by one. */
export function closedProjectIds(projects: readonly Pick<BrainProjectSnapshot, "id" | "status">[]): Set<string> {
  return new Set(projects.flatMap((project) => project.id && (project.status === "done" || project.status === "archived") ? [project.id] : []));
}

export interface FollowUpOptions {
  closedProjectIds?: ReadonlySet<string>;
  createId?: () => string;
}

/**
 * Adds the next occurrence of every repeating task that `after` completes
 * while `before` (the vault as it is now) still has it open. Runs on every
 * save, so it must be idempotent: a later open task of the same chain counts
 * as already created, even after it was moved to another day.
 */
export function withRecurringFollowUps(
  before: readonly BrainTaskSnapshot[],
  after: readonly BrainTaskSnapshot[],
  today: string,
  { closedProjectIds: closed = new Set(), createId = () => crypto.randomUUID() }: FollowUpOptions = {},
): BrainTaskSnapshot[] {
  const wasDone = new Map(before.flatMap((task) => task.id ? [[task.id, task.status === "done"] as const] : []));
  const result: BrainTaskSnapshot[] = [];
  for (const task of after) {
    result.push(task);
    if (task.status !== "done" || !task.recurrence || !task.id || wasDone.get(task.id) !== false) continue;
    if (task.projectId && closed.has(task.projectId)) continue;
    const date = nextRecurringDate(task, today);
    if (!date) continue;
    const title = task.title.replace(BLOCK_ID, "").trim() || task.title;
    // The same chain: same rule, title, project, time and file, dated after
    // this one. Twin chains ("吃藥" at 08:00 and 20:00) stay independent.
    const exists = [...after, ...result].some((item) => item.id !== task.id
      && item.status !== "done"
      && item.title === title
      && item.recurrence === task.recurrence
      && (item.projectId ?? null) === (task.projectId ?? null)
      && (item.startTime ?? null) === (task.startTime ?? null)
      && (item.sourcePath ?? null) === (task.sourcePath ?? null)
      && (item.taskDate ?? "") > (task.taskDate ?? ""));
    if (exists) continue;
    result.push({
      ...task,
      id: createId(),
      title,
      status: "todo",
      taskDate: date,
      completedAt: null,
      // A day owns one P1; the copy should not steal it from a future day.
      priority: task.priority === "highest" ? "high" : task.priority,
      // Written next to the original when that file still exists.
      sourceHeading: null,
      ...(task.body !== undefined ? { body: resetChecklist(task.body) } : {}),
    });
  }
  return result;
}
