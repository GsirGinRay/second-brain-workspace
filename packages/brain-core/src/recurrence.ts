import { isValidDateKey } from "./dates";

/**
 * Recurrence rules use the Obsidian Tasks `🔁 every …` wording so a vault
 * opened in Obsidian on a phone keeps the same repeating tasks. Only the
 * subset below is understood; anything else is left as ordinary title text.
 */
export type RecurrenceRule =
  | { unit: "day"; interval: number }
  | { unit: "weekday" }
  | { unit: "week"; interval: number; weekdays: number[] }
  | { unit: "month"; interval: number; day: number | "last" | null }
  | { unit: "year"; interval: number };

const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const MAX_INTERVAL = 365;

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function parseInterval(value: string | undefined): number | null {
  if (!value) return 1;
  const interval = Number(value);
  return Number.isInteger(interval) && interval >= 1 && interval <= MAX_INTERVAL ? interval : null;
}

function parseWeekdays(list: string): number[] | null {
  const days = list.split(/\s*(?:,|\band\b)\s*/).filter(Boolean).map((name) => WEEKDAY_NAMES.indexOf(name as typeof WEEKDAY_NAMES[number]));
  if (!days.length || days.some((day) => day < 0)) return null;
  return [...new Set(days)].sort((left, right) => left - right);
}

export function parseRecurrence(text: string): RecurrenceRule | null {
  const value = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (value === "every weekday") return { unit: "weekday" };
  const bareWeekdays = /^every ([a-z]+(?:\s*(?:,|\band\b)\s*[a-z]+)*)$/.exec(value);
  const bareDays = bareWeekdays ? parseWeekdays(bareWeekdays[1]!) : null;
  if (bareDays) return { unit: "week", interval: 1, weekdays: bareDays };
  const simple = /^every (?:(\d+) )?(day|week|month|year)s?(?: on (.+))?$/.exec(value);
  if (!simple) return null;
  const interval = parseInterval(simple[1]);
  if (interval === null) return null;
  const unit = simple[2] as "day" | "week" | "month" | "year";
  const on = simple[3];
  if (unit === "day" || unit === "year") return on ? null : { unit, interval };
  if (unit === "week") {
    if (!on) return { unit, interval, weekdays: [] };
    const weekdays = parseWeekdays(on);
    return weekdays ? { unit, interval, weekdays } : null;
  }
  if (!on) return { unit, interval, day: null };
  if (on === "the last" || on === "the last day") return { unit, interval, day: "last" };
  const day = /^the (\d{1,2})(?:st|nd|rd|th)$/.exec(on);
  const dayNumber = day ? Number(day[1]) : NaN;
  return dayNumber >= 1 && dayNumber <= 31 ? { unit, interval, day: dayNumber } : null;
}

function ordinal(day: number): string {
  if (day % 100 >= 11 && day % 100 <= 13) return `${day}th`;
  return `${day}${["th", "st", "nd", "rd"][day % 10] ?? "th"}`;
}

/** Canonical Obsidian Tasks wording, without the 🔁 icon. */
export function formatRecurrence(rule: RecurrenceRule): string {
  if (rule.unit === "weekday") return "every weekday";
  const every = rule.interval === 1 ? `every ${rule.unit}` : `every ${rule.interval} ${rule.unit}s`;
  if (rule.unit === "week" && rule.weekdays.length) {
    return `${every} on ${rule.weekdays.map((day) => capitalize(WEEKDAY_NAMES[day]!)).join(", ")}`;
  }
  if (rule.unit === "month" && rule.day !== null) {
    return `${every} on the ${rule.day === "last" ? "last" : ordinal(rule.day)}`;
  }
  return every;
}

function toDate(dateKey: string): Date {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!));
}

function toKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function addMonthsClamped(date: Date, months: number, day: number | "last"): Date {
  const total = date.getUTCFullYear() * 12 + date.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const monthIndex = total % 12;
  const last = daysInMonth(year, monthIndex);
  return new Date(Date.UTC(year, monthIndex, day === "last" ? last : Math.min(day, last)));
}

/** The first occurrence strictly after `fromDateKey`. */
export function nextOccurrence(rule: RecurrenceRule, fromDateKey: string): string {
  if (!isValidDateKey(fromDateKey)) throw new Error(`Invalid date key: ${fromDateKey}`);
  const from = toDate(fromDateKey);
  switch (rule.unit) {
    case "day":
      return toKey(addDays(from, rule.interval));
    case "weekday": {
      let next = addDays(from, 1);
      while (next.getUTCDay() === 0 || next.getUTCDay() === 6) next = addDays(next, 1);
      return toKey(next);
    }
    case "week": {
      if (!rule.weekdays.length) return toKey(addDays(from, 7 * rule.interval));
      const weekday = from.getUTCDay();
      const later = rule.weekdays.find((day) => day > weekday);
      if (later !== undefined) return toKey(addDays(from, later - weekday));
      // Wrap to the first listed weekday of the next active week.
      return toKey(addDays(from, 7 * rule.interval - weekday + rule.weekdays[0]!));
    }
    case "month": {
      const day = rule.day ?? from.getUTCDate();
      if (day === "last" || day >= from.getUTCDate()) {
        const sameMonth = addMonthsClamped(from, 0, day);
        if (sameMonth > from && rule.day !== null) return toKey(sameMonth);
      }
      return toKey(addMonthsClamped(from, rule.interval, day));
    }
    case "year":
      return toKey(addMonthsClamped(from, 12 * rule.interval, from.getUTCDate()));
  }
}

const ZH_WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];
const EN_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Short human label, e.g. 每週一、三 / Every Mon, Wed. */
export function describeRecurrence(rule: RecurrenceRule, language: "zh-TW" | "en"): string {
  const zh = language === "zh-TW";
  if (rule.unit === "weekday") return zh ? "每個工作日" : "Every weekday";
  const zhUnit = { day: "天", week: "週", month: "月", year: "年" }[rule.unit];
  const zhCounted = rule.unit === "month" ? "個月" : zhUnit;
  const enUnit = rule.interval === 1 ? rule.unit : `${rule.interval} ${rule.unit}s`;
  const prefix = zh
    ? (rule.interval === 1 ? `每${zhUnit}` : `每 ${rule.interval} ${zhCounted}`)
    : `Every ${enUnit}`;
  if (rule.unit === "week" && rule.weekdays.length) {
    return zh
      ? `${prefix}${rule.weekdays.map((day) => ZH_WEEKDAYS[day]).join("、")}`
      : `${prefix} on ${rule.weekdays.map((day) => EN_WEEKDAYS[day]).join(", ")}`;
  }
  if (rule.unit === "month" && rule.day !== null) {
    if (rule.day === "last") return zh ? `${prefix}最後一天` : `${prefix} on the last day`;
    return zh ? `${prefix} ${rule.day} 號` : `${prefix} on the ${ordinal(rule.day)}`;
  }
  return prefix;
}
