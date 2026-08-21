import type { BrainTaskSnapshot } from "@second-brain/brain-core";

const PRIORITY_DISPLAY: Record<BrainTaskSnapshot["priority"], { code: string; label: string }> = {
  highest: { code: "P1", label: "最重要" },
  high: { code: "P2", label: "高" },
  medium: { code: "P3", label: "中" },
  normal: { code: "P4", label: "一般" },
  low: { code: "P5", label: "低" },
};

export function priorityDisplay(priority: BrainTaskSnapshot["priority"]): { code: string; label: string } {
  return PRIORITY_DISPLAY[priority];
}

export function completedForDate(tasks: readonly BrainTaskSnapshot[], date: string): BrainTaskSnapshot[] {
  return tasks
    .filter((task) => task.status === "done" && task.completedAt === date)
    .sort((left, right) => left.rank.localeCompare(right.rank));
}

export function filterCompletedTasks(
  tasks: readonly BrainTaskSnapshot[],
  showCompleted: boolean,
): BrainTaskSnapshot[] {
  return showCompleted ? [...tasks] : tasks.filter((task) => task.status !== "done");
}

export type BoardLane = "idea" | "todo" | "doing" | "waiting" | "done";

export function boardLane(task: BrainTaskSnapshot): BoardLane {
  if (task.status === "todo" && (task.taskDate ?? null) === null) return "idea";
  return task.status;
}

export function moveTaskToLane(task: BrainTaskSnapshot, lane: BoardLane, today: string): BrainTaskSnapshot {
  if (lane === "idea") return { ...task, status: "todo", taskDate: null, completedAt: null };
  return {
    ...task,
    status: lane,
    taskDate: lane !== "done" && task.taskDate === null ? today : task.taskDate,
    completedAt: lane === "done" ? today : null,
  };
}

export function scheduleTask(
  task: BrainTaskSnapshot,
  taskDate: string,
  startTime?: string | null,
): BrainTaskSnapshot {
  if (startTime === undefined) return { ...task, taskDate };
  return {
    ...task,
    taskDate,
    startTime,
    durationMinutes: startTime ? (task.durationMinutes ?? 30) : null,
    timeZone: startTime ? "Asia/Taipei" : task.timeZone,
  };
}

function addDays(dateKey: string, amount: number): string {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

export function nextWeekPriorities(tasks: readonly BrainTaskSnapshot[], today: string): BrainTaskSnapshot[] {
  const end = addDays(today, 7);
  return tasks
    .filter((task) => task.status !== "done" && (task.priority === "highest" || task.priority === "high"))
    .filter((task) => {
      const date = task.taskDate;
      return Boolean(date && date > today && date <= end);
    })
    .sort((left, right) =>
      (left.taskDate ?? "").localeCompare(right.taskDate ?? "") ||
      left.rank.localeCompare(right.rank));
}

export function markMostImportant(
  tasks: BrainTaskSnapshot[],
  taskId: string,
  date: string,
): BrainTaskSnapshot[] {
  return tasks.map((task) => {
    if (task.id === taskId) return { ...task, taskDate: date, priority: "highest" };
    if (task.taskDate === date && task.priority === "highest") return { ...task, priority: "high" };
    return task;
  });
}

export function archiveTask(task: BrainTaskSnapshot, completedAt: string): BrainTaskSnapshot {
  return { ...task, status: "done", completedAt };
}

export function isQuickAddShortcut(input: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  editable: boolean;
}): boolean {
  return input.key.toLowerCase() === "n" && !input.metaKey && !input.ctrlKey && !input.altKey && !input.editable;
}

export function isCompleteShortcut(input: { key: string; editable: boolean }): boolean {
  return !input.editable && (input.key === " " || input.key === "Enter");
}

export function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName);
}
