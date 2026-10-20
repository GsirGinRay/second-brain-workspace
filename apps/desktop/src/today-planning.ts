import type { BrainTaskSnapshot } from "@second-brain/brain-core";

export const AVAILABLE_HOURS_KEY = "second-brain.availableHours";
export const AVAILABLE_HOUR_OPTIONS = [4, 5, 6, 7, 8, 9, 10, 12] as const;
export const DEFAULT_AVAILABLE_HOURS = 8;
// Tasks without an estimate still take time; count them as a short block.
export const UNESTIMATED_TASK_MINUTES = 30;

export interface DayLoad {
  plannedMinutes: number;
  availableMinutes: number;
  /** Open tasks without a duration, counted as UNESTIMATED_TASK_MINUTES each. */
  unestimated: number;
  overBy: number;
}

export function loadAvailableHours(storage: Pick<Storage, "getItem">): number {
  try {
    const value = Number(storage.getItem(AVAILABLE_HOURS_KEY));
    return AVAILABLE_HOUR_OPTIONS.includes(value as typeof AVAILABLE_HOUR_OPTIONS[number]) ? value : DEFAULT_AVAILABLE_HOURS;
  } catch {
    return DEFAULT_AVAILABLE_HOURS;
  }
}

export function dayLoad(tasks: readonly BrainTaskSnapshot[], availableHours: number): DayLoad {
  const open = tasks.filter((task) => task.status !== "done");
  const unestimated = open.filter((task) => !task.durationMinutes).length;
  const plannedMinutes = open.reduce((sum, task) => sum + (task.durationMinutes ?? UNESTIMATED_TASK_MINUTES), 0);
  const availableMinutes = availableHours * 60;
  return { plannedMinutes, availableMinutes, unestimated, overBy: Math.max(0, plannedMinutes - availableMinutes) };
}

export function formatHours(minutes: number, language: "zh-TW" | "en"): string {
  const hours = Math.round((minutes / 60) * 10) / 10;
  return language === "zh-TW" ? `${hours} 小時` : `${hours} h`;
}

/**
 * Focus order: the day's most important task first, then timed tasks by start
 * time, then the rest in their existing order. Overdue tasks come last.
 */
export function focusQueue(todayTasks: readonly BrainTaskSnapshot[], overdue: readonly BrainTaskSnapshot[]): BrainTaskSnapshot[] {
  const open = (items: readonly BrainTaskSnapshot[]) => items.filter((task) => task.status !== "done" && task.status !== "waiting" && task.id);
  const ordered = [...open(todayTasks)].sort((left, right) =>
    Number(right.priority === "highest") - Number(left.priority === "highest")
    || (left.startTime ?? "99:99").localeCompare(right.startTime ?? "99:99"));
  return [...ordered, ...open(overdue)];
}

export interface WaitingItem {
  task: BrainTaskSnapshot;
  /** The task date is the follow-up date; true once it has arrived. */
  followUpDue: boolean;
}

export function waitingItems(tasks: readonly BrainTaskSnapshot[], today: string): WaitingItem[] {
  return tasks
    .filter((task) => task.status === "waiting")
    .map((task) => ({ task, followUpDue: Boolean(task.taskDate && task.taskDate <= today) }))
    .sort((left, right) =>
      Number(right.followUpDue) - Number(left.followUpDue)
      || (left.task.taskDate ?? "9999-99-99").localeCompare(right.task.taskDate ?? "9999-99-99"));
}

export function addDaysToKey(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
}

/** Monday of the week containing `dateKey`. */
export function weekStart(dateKey: string): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const weekday = (new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay() + 6) % 7;
  return addDaysToKey(dateKey, -weekday);
}

export interface WrapUpSummary {
  doneToday: BrainTaskSnapshot[];
  doneThisWeek: number;
  /** Projects with the most completions this week, busiest first (max 3). */
  topProjects: { name: string; count: number }[];
  /** Open tasks dated today or earlier: candidates to move to tomorrow. */
  unfinished: BrainTaskSnapshot[];
}

export function wrapUpSummary(tasks: readonly BrainTaskSnapshot[], today: string): WrapUpSummary {
  const monday = weekStart(today);
  const doneThisWeek = tasks.filter((task) => task.status === "done" && task.completedAt && task.completedAt >= monday && task.completedAt <= today);
  const byProject = new Map<string, number>();
  for (const task of doneThisWeek) {
    if (task.projectName) byProject.set(task.projectName, (byProject.get(task.projectName) ?? 0) + 1);
  }
  return {
    doneToday: tasks.filter((task) => task.status === "done" && task.completedAt === today),
    doneThisWeek: doneThisWeek.length,
    topProjects: [...byProject].map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
      .slice(0, 3),
    unfinished: tasks.filter((task) => task.status !== "done" && task.status !== "waiting" && task.id && task.taskDate && task.taskDate <= today),
  };
}

/** Moves the chosen tasks to `date`, keeping their start time on the new day. */
export function moveTasksToDate(tasks: readonly BrainTaskSnapshot[], ids: ReadonlySet<string>, date: string): BrainTaskSnapshot[] {
  return tasks.map((task) => task.id && ids.has(task.id) ? { ...task, taskDate: date } : task);
}
