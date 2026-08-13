import type { BrainProjectSnapshot, BrainTaskSnapshot } from "./types";

const PRIORITY_WEIGHT: Record<string, number> = {
  highest: 0,
  high: 1,
  medium: 2,
  normal: 3,
  low: 4,
};

export function rankForIndex(index: number): string {
  return String(Math.max(0, index)).padStart(8, "0");
}

export function getTodayTasks<
  T extends
    Pick<
      BrainTaskSnapshot,
      "id" | "status" | "taskDate" | "priority" | "projectId" | "rank"
    >,
  P extends Pick<BrainProjectSnapshot, "id" | "focusToday">,
>(tasks: readonly T[], projects: readonly P[], today: string): T[] {
  const focusIds = new Set(
    projects.filter((project) => project.focusToday).map((project) => project.id),
  );
  const included = tasks.filter(
    (task) =>
      task.status !== "done" &&
      Boolean(
        (task.taskDate && task.taskDate <= today) ||
          task.status === "doing" ||
          (task.projectId && focusIds.has(task.projectId)),
      ),
  );
  const category = (task: T) => {
    if (task.taskDate && task.taskDate < today) return 0;
    if (task.taskDate === today) return 1;
    if (task.status === "doing") return 2;
    return 3;
  };
  return [...included].sort(
    (left, right) =>
      category(left) - category(right) ||
      (PRIORITY_WEIGHT[left.priority] ?? 3) -
        (PRIORITY_WEIGHT[right.priority] ?? 3) ||
      (left.taskDate ?? "9999-99-99").localeCompare(right.taskDate ?? "9999-99-99") ||
      left.rank.localeCompare(right.rank),
  );
}
