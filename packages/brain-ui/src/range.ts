import {
  addDateDays,
  buildMonthCells,
  buildWeekDates,
  type CalendarTaskEntry,
  type CalendarTaskLike,
} from "./calendar";

export type { CalendarTaskEntry } from "./calendar";

export type CalendarRangeMode = "month" | "week";

export interface CalendarDisplayRange {
  mode: CalendarRangeMode;
  startDate: string;
  endDate: string;
  label: string;
}

export interface ShiftedCalendarRange {
  month: string;
  weekAnchor: string;
}

function monthAdd(month: string, delta: number): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const total = year * 12 + monthNumber - 1 + delta;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, "0")}`;
}

export function getCalendarDisplayRange(
  mode: CalendarRangeMode,
  month: string,
  weekAnchor: string,
): CalendarDisplayRange {
  if (mode === "week") {
    const dates = buildWeekDates(weekAnchor);
    const startDate = dates[0] ?? weekAnchor;
    const endDate = dates[dates.length - 1] ?? weekAnchor;
    return {
      mode,
      startDate,
      endDate,
      label: `${startDate} – ${endDate}`,
    };
  }

  const monthCells = buildMonthCells(month).filter((cell) => cell.currentMonth);
  const startDate = monthCells[0]?.date ?? `${month}-01`;
  const endDate = monthCells[monthCells.length - 1]?.date ?? startDate;
  return {
    mode,
    startDate,
    endDate,
    label: month,
  };
}

export function shiftCalendarRange(
  mode: CalendarRangeMode,
  month: string,
  weekAnchor: string,
  delta: number,
): ShiftedCalendarRange {
  return mode === "week"
    ? { month, weekAnchor: addDateDays(weekAnchor, delta * 7) }
    : { month: monthAdd(month, delta), weekAnchor };
}

export function getEntriesInCalendarRange<T extends CalendarTaskLike>(
  entries: CalendarTaskEntry<T>[],
  range: Pick<CalendarDisplayRange, "startDate" | "endDate">,
): CalendarTaskEntry<T>[] {
  return entries.filter((entry) => entry.date >= range.startDate && entry.date <= range.endDate);
}
