import type { TaskPriority, TaskStatus } from "@second-brain/brain-core";
import { isValidDateKey } from "@second-brain/brain-core";

export const TAIPEI_TIME_ZONE = "Asia/Taipei";

export interface CalendarTaskLike {
  id: string;
  title: string;
  status: TaskStatus;
  taskDate: string | null;
  priority: TaskPriority;
  rank: string;
}

export interface CalendarTaskEntry<T extends CalendarTaskLike> {
  task: T;
  date: string;
  /** Compatibility flags for the V2 calendar shell. V3 always has one task-date entry. */
  planned: true;
  due: false;
  overdue: false;
}

export interface CalendarMonthCell {
  date: string;
  day: number;
  currentMonth: boolean;
}

function dateParts(date: Date, timeZone: string): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

export function dateKeyFromDate(date: Date, timeZone = TAIPEI_TIME_ZONE): string {
  const parts = dateParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export const taipeiDateKey = (date: Date): string => dateKeyFromDate(date);

function assertDateKey(value: string): void {
  if (!isValidDateKey(value)) throw new RangeError(`Invalid date key: ${value}`);
}

function dateFromKey(value: string): Date {
  assertDateKey(value);
  return new Date(`${value}T00:00:00.000Z`);
}

export function addDateDays(value: string, amount: number): string {
  const date = dateFromKey(value);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function monthParts(month: string): { year: number; month: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) throw new RangeError(`Invalid month key: ${month}`);
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (monthNumber < 1 || monthNumber > 12) throw new RangeError(`Invalid month key: ${month}`);
  return { year, month: monthNumber };
}

export function buildMonthCells(month: string): CalendarMonthCell[] {
  const { year, month: monthNumber } = monthParts(month);
  const firstDate = `${month}-${"01"}`;
  const firstDayOfWeek = dateFromKey(firstDate).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const count = Math.ceil((firstDayOfWeek + daysInMonth) / 7) * 7;
  const firstCell = addDateDays(firstDate, -firstDayOfWeek);
  return Array.from({ length: count }, (_, index) => {
    const date = addDateDays(firstCell, index);
    return {
      date,
      day: Number(date.slice(8, 10)),
      currentMonth: date.slice(0, 7) === month,
    };
  });
}

export function buildWeekDates(anchorDate: string): string[] {
  const day = dateFromKey(anchorDate).getUTCDay();
  const first = addDateDays(anchorDate, -day);
  return Array.from({ length: 7 }, (_, index) => addDateDays(first, index));
}

export function getCalendarTaskEntries<T extends CalendarTaskLike>(
  tasks: readonly T[],
  today: string,
): CalendarTaskEntry<T>[] {
  assertDateKey(today);
  const entries: CalendarTaskEntry<T>[] = [];
  for (const task of tasks) {
    if (!task.taskDate) continue;
    assertDateKey(task.taskDate);
    entries.push({ task, date: task.taskDate, planned: true, due: false, overdue: false });
  }
  return entries.sort(
    (left, right) =>
      left.date.localeCompare(right.date) ||
      left.task.rank.localeCompare(right.task.rank) ||
      left.task.id.localeCompare(right.task.id),
  );
}

export function getUnscheduledTasks<T extends CalendarTaskLike>(tasks: readonly T[]): T[] {
  return tasks
    .filter((task) => task.status !== "done" && task.taskDate === null)
    .sort(
      (left, right) =>
        left.rank.localeCompare(right.rank) ||
        left.id.localeCompare(right.id),
    );
}

export function taskDatePatch(taskDate: string | null): { taskDate: string | null } {
  if (taskDate !== null) assertDateKey(taskDate);
  return { taskDate };
}
