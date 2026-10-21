import type { BrainTaskSnapshot } from "@second-brain/brain-core";
import { addDaysToKey, weekStart } from "./today-planning";

export interface ReviewDay {
  date: string;
  count: number;
  /** Days after today in the current week; drawn empty, not as zero. */
  future: boolean;
}

export interface WeeklyReview {
  start: string;
  /** Sunday of the week, or today while the week is still running. */
  end: string;
  days: ReviewDay[];
  done: number;
  /** Completions over the same weekdays of the week before. */
  previousDone: number;
  /** Sum of the estimates on finished tasks. */
  estimatedMinutes: number;
  /** Finished tasks without an estimate, so the time total reads as partial. */
  unestimated: number;
  projects: { name: string; count: number }[];
  /** Finished tasks that belong to no project. */
  unassigned: number;
  isCurrentWeek: boolean;
}

const MAX_PROJECTS = 5;

function doneBetween(tasks: readonly BrainTaskSnapshot[], from: string, to: string): BrainTaskSnapshot[] {
  return tasks.filter((task) => task.status === "done" && task.completedAt && task.completedAt >= from && task.completedAt <= to);
}

/** Review of the week `offset` weeks before the one containing `today`. */
export function weeklyReview(tasks: readonly BrainTaskSnapshot[], today: string, offset = 0): WeeklyReview {
  const start = addDaysToKey(weekStart(today), -7 * offset);
  const sunday = addDaysToKey(start, 6);
  const isCurrentWeek = offset === 0;
  const end = isCurrentWeek ? today : sunday;
  const done = doneBetween(tasks, start, end);
  const counts = new Map<string, number>();
  for (const task of done) counts.set(task.completedAt!, (counts.get(task.completedAt!) ?? 0) + 1);
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = addDaysToKey(start, index);
    return { date, count: counts.get(date) ?? 0, future: date > end };
  });
  const span = days.filter((day) => !day.future).length;
  const previousStart = addDaysToKey(start, -7);
  const previousDone = doneBetween(tasks, previousStart, addDaysToKey(previousStart, span - 1)).length;
  const byProject = new Map<string, number>();
  for (const task of done) {
    if (task.projectName) byProject.set(task.projectName, (byProject.get(task.projectName) ?? 0) + 1);
  }
  return {
    start,
    end,
    days,
    done: done.length,
    previousDone,
    estimatedMinutes: done.reduce((sum, task) => sum + (task.durationMinutes ?? 0), 0),
    unestimated: done.filter((task) => !task.durationMinutes).length,
    projects: [...byProject].map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
      .slice(0, MAX_PROJECTS),
    unassigned: done.filter((task) => !task.projectName).length,
    isCurrentWeek,
  };
}

/**
 * Consecutive days with at least one completion, ending today. A day with
 * nothing done yet does not break the streak until it is over.
 */
export function completionStreak(tasks: readonly BrainTaskSnapshot[], today: string): number {
  const days = new Set(tasks.flatMap((task) => task.status === "done" && task.completedAt && task.completedAt <= today ? [task.completedAt] : []));
  let cursor = days.has(today) ? today : addDaysToKey(today, -1);
  let streak = 0;
  while (days.has(cursor)) {
    streak += 1;
    cursor = addDaysToKey(cursor, -1);
  }
  return streak;
}

/** Open tasks whose date has passed. */
export function overdueCount(tasks: readonly BrainTaskSnapshot[], today: string): number {
  return tasks.filter((task) => task.status !== "done" && task.status !== "waiting" && task.taskDate && task.taskDate < today).length;
}
