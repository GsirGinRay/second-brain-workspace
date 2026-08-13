import type { TaskPriority } from "./types";

export interface DailyPriorityTask {
  id: string;
  taskDate?: string | null;
  priority: TaskPriority;
  rank: string;
}

/** Keeps the first ranked P1 on each day and deterministically demotes the rest to P2. */
export function enforceDailyP1<T extends DailyPriorityTask>(tasks: readonly T[]): T[] {
  const winners = new Map<string, string>();
  const ordered = [...tasks].sort((left, right) =>
    left.rank.localeCompare(right.rank) || left.id.localeCompare(right.id));
  for (const task of ordered) {
    if (task.taskDate && task.priority === "highest" && !winners.has(task.taskDate)) {
      winners.set(task.taskDate, task.id);
    }
  }
  return tasks.map((task) =>
    task.taskDate && task.priority === "highest" && winners.get(task.taskDate) !== task.id
      ? { ...task, priority: "high" } as T
      : task);
}
