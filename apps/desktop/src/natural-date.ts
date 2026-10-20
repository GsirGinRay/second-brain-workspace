import { formatRecurrence, nextOccurrence, parseRecurrence, type RecurrenceRule } from "@second-brain/brain-core";

/**
 * Pure natural-language date / time / duration extraction for quick-add task
 * titles, in Traditional Chinese (with common Simplified variants) and English.
 *
 * All calendar math works on day numbers derived from `Date.UTC`, so results
 * never depend on the host timezone.
 *
 * Ambiguity decisions:
 * - A bare weekday ("週五", "friday") means the next occurrence, counting
 *   today: "週五" typed on a Friday is today.
 * - "這週X" / "this X" is X of the current Monday-based week, even if past.
 *   "下週X" / "next X" is X of the following Monday-based week.
 * - Month/day without a year ("10/25", "10月25日") is this year, or next year
 *   when that date is already before today.
 * - "下個月31號" in a shorter month clamps to the month's last day; the same
 *   clamp applies to "N個月後".
 * - "早上/上午12點" is 12:00 (people write 凌晨/半夜12點 for midnight).
 *   "凌晨/半夜12點" is 00:00. "12am" is 00:00 and "12pm" is 12:00.
 * - "晚上12點" is 00:00 of the next day, and "晚上1點".."晚上4點" are early
 *   hours of the next day; without a date they mean tonight, i.e. tomorrow.
 * - An hour without a period ("3點", "15:30") is read literally as 24h time.
 *   A Chinese-numeral hour without a period ("兩點") needs a suffix such as
 *   半 / 整 / 鐘 / N分, so phrases like "快一點" stay untouched.
 * - Recurring phrases ("每週五", "每月5號", "every monday") become a repeat
 *   rule in Obsidian Tasks wording; their first occurrence on or after today
 *   is the date unless the title also names an explicit date.
 * - Only the first phrase of each kind is used; later ones stay in the title.
 */

export interface NaturalDateSpan {
  readonly kind: "date" | "time" | "duration" | "recurrence";
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface NaturalDateMatch {
  /** Title with the recognized phrases removed and whitespace tidied. */
  readonly title: string;
  /** YYYY-MM-DD */
  readonly date?: string;
  /** HH:MM, 24h */
  readonly time?: string;
  readonly durationMinutes?: number;
  /** Repeat rule without the 🔁 icon, e.g. "every week on Monday". */
  readonly recurrence?: string;
  /** Days the time phrase itself moves forward ("晚上12點" → 1), relative to the intended day. */
  readonly timeDayOffset?: number;
  /** Recognized substrings in input order, joined by a single space. */
  readonly matchedText: string;
  /** Recognized substrings with their offsets in the original input. */
  readonly spans: readonly NaturalDateSpan[];
}

type Kind = NaturalDateSpan["kind"];

interface Candidate {
  readonly kind: Kind;
  readonly start: number;
  readonly end: number;
  readonly date?: string;
  readonly time?: string;
  /** Days to add to the recognized date (e.g. "晚上12點"). */
  readonly dayOffset?: number;
  /** Date implied by the time phrase itself (e.g. "今晚8點"), as days from today. */
  readonly impliedDateOffset?: number;
  readonly minutes?: number;
  readonly recurrence?: string;
}

interface Day {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------------------
// Calendar math
// ---------------------------------------------------------------------------

function parseDateKey(value: string): Day {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new RangeError(`Invalid date key: ${value}`);
  const parsed = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  if (!isValidDay(parsed.year, parsed.month, parsed.day)) {
    throw new RangeError(`Invalid date key: ${value}`);
  }
  return parsed;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isValidDay(year: number, month: number, day: number): boolean {
  return (
    Number.isInteger(year) &&
    year >= 1000 &&
    year <= 9999 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month)
  );
}

function toDayNumber({ year, month, day }: Day): number {
  return Math.round(Date.UTC(year, month - 1, day) / MS_PER_DAY);
}

function formatDayNumber(dayNumber: number): string {
  return new Date(dayNumber * MS_PER_DAY).toISOString().slice(0, 10);
}

function formatDay(day: Day): string {
  return formatDayNumber(toDayNumber(day));
}

function addDays(day: Day, amount: number): string {
  return formatDayNumber(toDayNumber(day) + amount);
}

/** Monday = 0 … Sunday = 6. */
function mondayIndex(day: Day): number {
  return (new Date(toDayNumber(day) * MS_PER_DAY).getUTCDay() + 6) % 7;
}

function addMonthsClamped(base: Day, months: number, day: number): string {
  const total = base.year * 12 + (base.month - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  return formatDay({ year, month, day: Math.min(day, daysInMonth(year, month)) });
}

/** This year's month/day, or next year's when it is already past. */
function upcomingMonthDay(today: Day, month: number, day: number): string | null {
  if (isValidDay(today.year, month, day)) {
    const candidate = { year: today.year, month, day };
    if (toDayNumber(candidate) >= toDayNumber(today)) return formatDay(candidate);
  }
  const nextYear = today.year + 1;
  return isValidDay(nextYear, month, day) ? formatDay({ year: nextYear, month, day }) : null;
}

function formatClock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

const CN_DIGITS: Readonly<Record<string, number>> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

const CN = "[零〇一二兩两三四五六七八九十]{1,3}";
const NUM = `(?:\\d{1,2}|${CN})`;

function cnDigit(value: string): number | undefined {
  return value.length === 1 ? CN_DIGITS[value] : undefined;
}

/** Parses ASCII digits or Chinese numerals up to 99. */
function parseNumber(value: string): number | null {
  if (/^\d+$/.test(value)) return Number(value);
  const tenAt = value.indexOf("十");
  if (tenAt === -1) return cnDigit(value) ?? null;
  if (value.indexOf("十", tenAt + 1) !== -1) return null;
  const head = value.slice(0, tenAt);
  const tail = value.slice(tenAt + 1);
  const tens = head === "" ? 1 : cnDigit(head);
  const ones = tail === "" ? 0 : cnDigit(tail);
  if (tens === undefined || ones === undefined || tens === 0) return null;
  return tens * 10 + ones;
}

const isCnNumeral = (value: string): boolean => /^[零〇一二兩两三四五六七八九十]+$/.test(value);

// ---------------------------------------------------------------------------
// Boundaries
// ---------------------------------------------------------------------------

/** Rejects matches glued to surrounding words, versions, codes and ordinals. */
function boundaryOk(input: string, start: number, end: number): boolean {
  const before = input[start - 1] ?? "";
  const after = input[end] ?? "";
  const first = input[start];
  const last = input[end - 1];
  if (before === "第" || before === "每") return false;
  if (/\d/.test(first) && /[A-Za-z0-9_.\/:\-]/.test(before)) return false;
  if (/[A-Za-z]/.test(first) && /[A-Za-z0-9_]/.test(before)) return false;
  if (/\d/.test(last) && (/[A-Za-z0-9_\/:]/.test(after) || (after === "." && /\d/.test(input[end + 1] ?? "")))) {
    return false;
  }
  if (/[A-Za-z.]/.test(last) && /[A-Za-z0-9_]/.test(after)) return false;
  return true;
}

function collect(
  input: string,
  pattern: RegExp,
  build: (match: RegExpMatchArray, start: number, end: number) => Candidate | null,
): Candidate[] {
  const found: Candidate[] = [];
  for (const match of input.matchAll(pattern)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (!boundaryOk(input, start, end)) continue;
    const candidate = build(match, start, end);
    if (candidate) found.push(candidate);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const RELATIVE_DAY_WORDS: Readonly<Record<string, number>> = {
  昨天: -1, 昨日: -1, 今天: 0, 今日: 0, 今早: 0, 今晚: 0, 明天: 1, 明日: 1, 明早: 1, 明晚: 1,
  後天: 2, 后天: 2, 大後天: 3, 大后天: 3,
  yesterday: -1, today: 0, tonight: 0, tomorrow: 1, tmr: 1, tmrw: 1,
};

const CN_WEEKDAY: Readonly<Record<string, number>> = {
  一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6, 七: 6,
};

const EN_WEEKDAY: Readonly<Record<string, number>> = {
  mon: 0, monday: 0, tue: 1, tues: 1, tuesday: 1, wed: 2, wednesday: 2,
  thu: 3, thur: 3, thurs: 3, thursday: 3, fri: 4, friday: 4,
  sat: 5, saturday: 5, sun: 6, sunday: 6,
};

type WeekScope = "upcoming" | "this" | "next" | "afterNext";

function weekdayDate(today: Day, target: number, scope: WeekScope): string {
  const current = mondayIndex(today);
  const delta = {
    upcoming: (target - current + 7) % 7,
    this: target - current,
    next: 7 - current + target,
    afterNext: 14 - current + target,
  }[scope];
  return addDays(today, delta);
}

function cnWeekScope(prefix: string | undefined): WeekScope {
  if (prefix === "下下") return "afterNext";
  if (prefix === "下") return "next";
  if (prefix) return "this";
  return "upcoming";
}

function dateCandidate(start: number, end: number, date: string | null): Candidate | null {
  return date ? { kind: "date", start, end, date } : null;
}

function findDates(input: string, today: Day): Candidate[] {
  return [
    // 2026-10-25, 2026/10/25, 2026.10.25
    ...collect(input, /(\d{4})([-/.])(\d{1,2})\2(\d{1,2})/g, (m, s, e) => {
      const [year, month, day] = [Number(m[1]), Number(m[3]), Number(m[4])];
      return dateCandidate(s, e, isValidDay(year, month, day) ? formatDay({ year, month, day }) : null);
    }),
    // 2026年10月25日, 10月25日, 10月25號, 十月二十五日, 10月25
    ...collect(
      input,
      new RegExp(`(?:(\\d{4})\\s*年\\s*)?(${NUM})\\s*月\\s*(${NUM})\\s*([日號号])?`, "g"),
      (m, s, e) => {
        const month = parseNumber(m[2]);
        const day = parseNumber(m[3]);
        if (month === null || day === null) return null;
        if (!m[4] && (isCnNumeral(m[3]) || /\d/.test(input[e] ?? ""))) return null;
        if (m[1]) {
          const year = Number(m[1]);
          return dateCandidate(s, e, isValidDay(year, month, day) ? formatDay({ year, month, day }) : null);
        }
        return dateCandidate(s, e, upcomingMonthDay(today, month, day));
      },
    ),
    // 10/25
    ...collect(input, /(\d{1,2})\/(\d{1,2})/g, (m, s, e) =>
      dateCandidate(s, e, upcomingMonthDay(today, Number(m[1]), Number(m[2]))),
    ),
    // 下個月5號, 這個月20日, 本月底 is not supported
    ...collect(input, new RegExp(`(下下|下|這|这|本)(?:個|个)?月\\s*(${NUM})\\s*[號号日]`, "g"), (m, s, e) => {
      const day = parseNumber(m[2]);
      if (day === null || day < 1 || day > 31) return null;
      const months = m[1] === "下下" ? 2 : m[1] === "下" ? 1 : 0;
      return dateCandidate(s, e, addMonthsClamped(today, months, day));
    }),
    // 3天後, 兩週後, 2個星期後, 3個月後
    ...collect(
      input,
      new RegExp(`(${NUM})\\s*(個|个)?\\s*(天|日|週|周|星期|禮拜|礼拜|月)\\s*(?:之|以)?[後后]`, "g"),
      (m, s, e) => {
        const amount = parseNumber(m[1]);
        if (amount === null || amount < 1) return null;
        const unit = m[3];
        if (unit === "月") return m[2] ? dateCandidate(s, e, addMonthsClamped(today, amount, today.day)) : null;
        if ((unit === "天" || unit === "日") && m[2]) return null;
        return dateCandidate(s, e, addDays(today, unit === "天" || unit === "日" ? amount : amount * 7));
      },
    ),
    // in 3 days, in 2 weeks
    ...collect(input, /\bin\s+(\d{1,3})\s*(days?|weeks?)\b/gi, (m, s, e) => {
      const amount = Number(m[1]);
      if (amount < 1) return null;
      return dateCandidate(s, e, addDays(today, m[2].toLowerCase().startsWith("week") ? amount * 7 : amount));
    }),
    // 下週五, 這星期一, 禮拜天, 週三
    ...collect(
      input,
      /(下下|下|這|这|本)?(?:個|个)?(?:週|周|星期|禮拜|礼拜)([一二三四五六日天七])/g,
      (m, s, e) => dateCandidate(s, e, weekdayDate(today, CN_WEEKDAY[m[2]], cnWeekScope(m[1]))),
    ),
    // next monday, this fri, on friday
    ...collect(
      input,
      /(?:\b(?:on|by|due)\s+)?\b(?:(next|this)\s+)?(monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat|sunday|sun)\b/gi,
      (m, s, e) => {
        const name = m[2].toLowerCase();
        const hasLead = Boolean(m[1]) || /^(on|by|due)\s/i.test(m[0]);
        // "sat" and "sun" are ordinary words; require a lead word for them.
        if ((name === "sat" || name === "sun") && !hasLead) return null;
        const prefix = m[1]?.toLowerCase();
        const scope: WeekScope = prefix === "next" ? "next" : prefix === "this" ? "this" : "upcoming";
        return dateCandidate(s, e, weekdayDate(today, EN_WEEKDAY[name], scope));
      },
    ),
    // 大後天, 明天, 今晚, tomorrow
    ...collect(
      input,
      /大[後后]天|[後后]天|[昨今明][天日]|[今明][早晚]|(?:\b(?:on|by|due)\s+)?\b(?:yesterday|today|tonight|tomorrow|tmrw|tmr)\b/gi,
      (m, s, e) => {
        const word = m[0].replace(/^(on|by|due)\s+/i, "").toLowerCase();
        const offset = RELATIVE_DAY_WORDS[word];
        return offset === undefined ? null : dateCandidate(s, e, addDays(today, offset));
      },
    ),
  ];
}

// ---------------------------------------------------------------------------
// Times
// ---------------------------------------------------------------------------

const PERIOD = "早上|上午|中午|下午|傍晚|晚上|凌晨|半夜|今早|明早|今晚|明晚";

const PERIOD_IMPLIED_DATE: Readonly<Record<string, number>> = { 今早: 0, 今晚: 0, 明早: 1, 明晚: 1 };

interface ClockTime {
  readonly time: string;
  readonly dayOffset: number;
}

function clock(hour: number, minute: number, dayOffset = 0): ClockTime {
  return { time: formatClock(hour * 60 + minute), dayOffset };
}

function toClock(period: string | undefined, hour: number, minute: number): ClockTime | null {
  if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return null;
  if (!period) return clock(hour, minute);
  if (period === "凌晨" || period === "半夜") return hour <= 12 ? clock(hour % 12, minute) : null;
  if (period === "早上" || period === "上午" || period === "今早" || period === "明早") {
    return hour <= 12 ? clock(hour, minute) : null;
  }
  if (period === "中午") {
    if (hour >= 11) return clock(hour, minute);
    return hour >= 1 && hour <= 4 ? clock(hour + 12, minute) : null;
  }
  if (period === "下午" || period === "傍晚") return clock(hour < 12 ? hour + 12 : hour, minute);
  // 晚上 / 今晚 / 明晚
  if (hour === 12 || hour === 0) return clock(0, minute, 1);
  if (hour <= 4) return clock(hour, minute, 1);
  return clock(hour < 12 ? hour + 12 : hour, minute);
}

function toClockMeridiem(meridiem: string, hour: number, minute: number): ClockTime | null {
  if (hour < 1 || hour > 12 || minute > 59) return null;
  const pm = meridiem.toLowerCase().startsWith("p");
  return clock((hour % 12) + (pm ? 12 : 0), minute);
}

function timeCandidate(
  start: number,
  end: number,
  value: ClockTime | null,
  period?: string,
): Candidate | null {
  if (!value) return null;
  const implied = period ? PERIOD_IMPLIED_DATE[period] : undefined;
  return {
    kind: "time",
    start,
    end,
    time: value.time,
    dayOffset: value.dayOffset,
    ...(implied === undefined ? {} : { impliedDateOffset: implied }),
  };
}

function findTimes(input: string): Candidate[] {
  return [
    // 下午3點, 3點半, 晚上8點15分, 兩點整, 十點鐘
    ...collect(
      input,
      new RegExp(`(?:(${PERIOD})\\s*)?(${NUM})\\s*[點点](?:(半)|(整|鐘|钟)|\\s*(${NUM})\\s*(分)?)?`, "g"),
      (m, s, e) => {
        const period = m[1];
        const hour = parseNumber(m[2]);
        if (hour === null) return null;
        const hasSuffix = Boolean(m[3] || m[4] || m[5]);
        if (!period && isCnNumeral(m[2]) && !hasSuffix) return null;
        if (m[5] && !m[6] && isCnNumeral(m[5])) return null;
        const minute = m[3] ? 30 : m[5] ? parseNumber(m[5]) : 0;
        if (minute === null) return null;
        return timeCandidate(s, e, toClock(period, hour, minute), period);
      },
    ),
    // 15:30, 下午3:30, at 3:30pm
    ...collect(
      input,
      new RegExp(`(?:(${PERIOD})\\s*|\\bat\\s+)?(\\d{1,2}):(\\d{2})(?:\\s*([ap]\\.?m\\.?))?`, "gi"),
      (m, s, e) => {
        const [hour, minute] = [Number(m[2]), Number(m[3])];
        const value = m[4] ? toClockMeridiem(m[4], hour, minute) : toClock(m[1], hour, minute);
        return timeCandidate(s, e, value, m[1]);
      },
    ),
    // 3pm, at 11am
    ...collect(input, /(?:\bat\s+)?(\d{1,2})\s*([ap]\.?m\.?)/gi, (m, s, e) =>
      timeCandidate(s, e, toClockMeridiem(m[2], Number(m[1]), 0)),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

function durationCandidate(start: number, end: number, minutes: number | null): Candidate | null {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) return null;
  return { kind: "duration", start, end, minutes: Math.round(minutes) };
}

function findDurations(input: string): Candidate[] {
  const decimal = `\\d{1,3}(?:\\.\\d+)?|${CN}`;
  return [
    // 1小時, 1.5小時, 一個半小時, 半小時, 2小時30分鐘
    ...collect(
      input,
      new RegExp(
        `(?:(${decimal})\\s*(?:個|个)?\\s*(半)?|(半)\\s*(?:個|个)?)\\s*(?:小時|小时|鐘頭|钟头)(?:\\s*(${NUM})\\s*分(?:鐘|钟)?)?`,
        "g",
      ),
      (m, s, e) => {
        const whole = m[1] ? (/^\d/.test(m[1]) ? Number(m[1]) : parseNumber(m[1])) : 0;
        if (whole === null) return null;
        const half = m[2] || m[3] ? 0.5 : 0;
        const extra = m[4] ? parseNumber(m[4]) : 0;
        if (extra === null || extra > 59) return null;
        return durationCandidate(s, e, (whole + half) * 60 + extra);
      },
    ),
    // 30分鐘, 四十五分鐘
    ...collect(input, new RegExp(`(\\d{1,3}|${CN})\\s*分(?:鐘|钟)`, "g"), (m, s, e) =>
      durationCandidate(s, e, parseNumber(m[1])),
    ),
    // 2h, 1.5 hours, 1h30m, for 90 min
    ...collect(
      input,
      /(?:\bfor\s+)?(\d{1,3}(?:\.\d+)?)\s*(?:hours?|hrs?|h)(?:\s*(\d{1,2})\s*(?:minutes?|mins?|m))?\b/gi,
      (m, s, e) => durationCandidate(s, e, Number(m[1]) * 60 + (m[2] ? Number(m[2]) : 0)),
    ),
    ...collect(input, /(?:\bfor\s+)?(\d{1,3})\s*(?:minutes?|mins?|m)\b/gi, (m, s, e) =>
      durationCandidate(s, e, Number(m[1])),
    ),
  ];
}

// ---------------------------------------------------------------------------
// Recurrence
// ---------------------------------------------------------------------------

const CN_WEEK_WORD = "(?:週|周|星期|禮拜|礼拜)";
const CN_WEEKDAY_LIST = "[一二三四五六日天](?:\\s*[、,，和跟及]?\\s*[一二三四五六日天])*";
const WEEKDAY_NAMES_BY_INDEX = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
function recurrenceCandidate(start: number, end: number, parsed: RecurrenceRule | null, today: Day): Candidate | null {
  if (!parsed) return null;
  // "每月" pins today's day of month, so short months cannot make it drift.
  const rule: RecurrenceRule = parsed.unit === "month" && parsed.day === null ? { ...parsed, day: today.day } : parsed;
  // Anchored rules start on their first matching day on or after today; open
  // ones start today. The interval only applies from that first day on.
  const anchored = rule.unit === "weekday"
    || (rule.unit === "week" && rule.weekdays.length > 0)
    || rule.unit === "month";
  const firstStep: RecurrenceRule = "interval" in rule ? { ...rule, interval: 1 } : rule;
  const date = anchored ? nextOccurrence(firstStep, addDays(today, -1)) : formatDay(today);
  return { kind: "recurrence", start, end, recurrence: formatRecurrence(rule), date };
}

/** Monday-based weekday index (as in CN_WEEKDAY / EN_WEEKDAY) to Sunday-based. */
const sundayBased = (mondayBased: number): number => (mondayBased + 1) % 7;

function cnInterval(value: string | undefined): number | null {
  return value ? parseNumber(value) : 1;
}

/** "every mon" -> "every monday", so the shared rule parser understands it. */
function expandEnglishWeekdays(text: string): string {
  return text.replace(/\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b/gi, (day) =>
    WEEKDAY_NAMES_BY_INDEX[sundayBased(EN_WEEKDAY[day.toLowerCase()]!)]!);
}

function findEnglishRecurrences(input: string, today: Day): Candidate[] {
  // Only "every …" phrases: words such as "daily" or "weekly" are usually part
  // of a title ("Write weekly report"), so they are never read as a rule.
  return [...input.matchAll(/\bevery\b[A-Za-z0-9 ,]*/gi)].flatMap((match) => {
    const start = match.index ?? 0;
    // The longest word prefix that parses wins, so trailing title words stay.
    const words = match[0].split(" ");
    for (let count = words.length; count > 1; count -= 1) {
      const text = words.slice(0, count).join(" ").replace(/[\s,]+$/, "");
      const rule = parseRecurrence(expandEnglishWeekdays(text));
      if (rule) return [recurrenceCandidate(start, start + text.length, rule, today)];
    }
    return [];
  }).filter((item): item is Candidate => item !== null);
}

function findRecurrences(input: string, today: Day): Candidate[] {
  return [
    ...findEnglishRecurrences(input, today),
    ...collect(input, /每(?:一)?(?:天|日)/g, (_m, s, e) => recurrenceCandidate(s, e, { unit: "day", interval: 1 }, today)),
    ...collect(input, new RegExp(`每(${CN}|\\d{1,2})\\s*天`, "g"), (m, s, e) => {
      const interval = cnInterval(m[1]);
      return interval ? recurrenceCandidate(s, e, { unit: "day", interval }, today) : null;
    }),
    ...collect(input, /每(?:個|个)?(?:工作日|平日)/g, (_m, s, e) => recurrenceCandidate(s, e, { unit: "weekday" }, today)),
    ...collect(input, new RegExp(`每(?:(${CN}|\\d{1,2})\\s*)?(?:個|个)?${CN_WEEK_WORD}(${CN_WEEKDAY_LIST})?`, "g"), (m, s, e) => {
      const interval = cnInterval(m[1]);
      if (!interval) return null;
      const weekdays = [...new Set([...(m[2] ?? "")].flatMap((char) =>
        CN_WEEKDAY[char] === undefined ? [] : [sundayBased(CN_WEEKDAY[char]!)]))].sort((a, b) => a - b);
      return recurrenceCandidate(s, e, { unit: "week", interval, weekdays }, today);
    }),
    ...collect(input, new RegExp(`每(?:(${CN}|\\d{1,2})\\s*)?(?:個|个)?月(?:(${NUM})\\s*(?:號|号|日)|(底|最後一天|最后一天))?`, "g"), (m, s, e) => {
      const interval = cnInterval(m[1]);
      const day = m[2] ? parseNumber(m[2]) : m[3] ? "last" as const : null;
      if (!interval || (typeof day === "number" && (day < 1 || day > 31))) return null;
      return recurrenceCandidate(s, e, { unit: "month", interval, day }, today);
    }),
    ...collect(input, /每(?:一)?年/g, (_m, s, e) => recurrenceCandidate(s, e, { unit: "year", interval: 1 }, today)),
  ];
}

// ---------------------------------------------------------------------------
// Selection and title cleanup
// ---------------------------------------------------------------------------

function selectCandidates(candidates: readonly Candidate[]): Candidate[] {
  const ordered = [...candidates].sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  return ordered.reduce<Candidate[]>((chosen, candidate) => {
    const kindTaken = chosen.some((item) => item.kind === candidate.kind);
    const overlaps = chosen.some((item) => candidate.start < item.end && item.start < candidate.end);
    return kindTaken || overlaps ? chosen : [...chosen, candidate];
  }, []).sort((a, b) => a.start - b.start);
}

/** Widens a span over connectors that would dangle once it is removed. */
function widenSpan(input: string, span: Candidate): { start: number; end: number } {
  let end = span.end;
  if (span.kind !== "duration") {
    // "週五前交報告" -> "交報告", but keep words such as 前往 / 前面.
    const deadline = /^(?:(?:之|以)前|前(?![往進进面後后端台]))/.exec(input.slice(end));
    if (deadline) end += deadline[0].length;
  }
  if (input[end] === "的") end += 1;
  let start = span.start;
  const before = input[start - 1];
  if ((before === "在" || before === "於" || before === "于") && (start === 1 || /[\s,，、]/.test(input[start - 2]))) {
    start -= 1;
  }
  return { start, end };
}

const EDGE_PUNCTUATION = /^[\s,，、;；:：\-–—]+|[\s,，、;；:：\-–—]+$/g;

function removeSpans(input: string, spans: readonly Candidate[]): string {
  const ranges = spans.map((span) => widenSpan(input, span));
  // Rebuild with a separator between ASCII words that the removal glued together.
  const glued = ranges.reduce<{ text: string; cursor: number }>(
    (acc, range) => {
      const piece = input.slice(acc.cursor, range.start);
      const joint = /[A-Za-z0-9]$/.test(acc.text) && /^[A-Za-z0-9]/.test(piece) ? " " : "";
      return { text: acc.text + joint + piece, cursor: Math.max(acc.cursor, range.end) };
    },
    { text: "", cursor: 0 },
  );
  const tail = input.slice(glued.cursor);
  const joint = /[A-Za-z0-9]$/.test(glued.text) && /^[A-Za-z0-9]/.test(tail) ? " " : "";
  return (glued.text + joint + tail).replace(/\s+/g, " ").replace(EDGE_PUNCTUATION, "");
}

/**
 * Extracts the first date, time and duration phrase from a quick-add title.
 * Returns null when nothing is recognized. `today` must be a YYYY-MM-DD key.
 */
export interface NaturalDateOptions {
  /** Only recognize these kinds; other phrases stay in the title. Defaults to all. */
  readonly kinds?: readonly Kind[];
}

export function parseNaturalDate(input: string, today: string, options: NaturalDateOptions = {}): NaturalDateMatch | null {
  const base = parseDateKey(today);
  const kinds = new Set<Kind>(options.kinds ?? ["date", "time", "duration", "recurrence"]);
  const chosen = selectCandidates([
    ...(kinds.has("recurrence") ? findRecurrences(input, base) : []),
    ...(kinds.has("date") ? findDates(input, base) : []),
    ...(kinds.has("time") ? findTimes(input) : []),
    ...(kinds.has("duration") ? findDurations(input) : []),
  ]);
  if (chosen.length === 0) return null;

  const dateHit = chosen.find((item) => item.kind === "date");
  const timeHit = chosen.find((item) => item.kind === "time");
  const durationHit = chosen.find((item) => item.kind === "duration");
  const recurrenceHit = chosen.find((item) => item.kind === "recurrence");

  // "晚上12點" with no date still means tonight's midnight, i.e. tomorrow 00:00.
  const baseDate =
    dateHit?.date ??
    recurrenceHit?.date ??
    (timeHit?.impliedDateOffset !== undefined
      ? addDays(base, timeHit.impliedDateOffset)
      : timeHit?.dayOffset ? today : undefined);
  const date =
    baseDate && timeHit?.dayOffset ? addDays(parseDateKey(baseDate), timeHit.dayOffset) : baseDate;

  const spans = chosen.map<NaturalDateSpan>((item) => ({
    kind: item.kind,
    start: item.start,
    end: item.end,
    text: input.slice(item.start, item.end),
  }));

  return {
    title: removeSpans(input, chosen),
    ...(date ? { date } : {}),
    ...(timeHit?.time ? { time: timeHit.time } : {}),
    ...(durationHit?.minutes ? { durationMinutes: durationHit.minutes } : {}),
    ...(recurrenceHit?.recurrence ? { recurrence: recurrenceHit.recurrence } : {}),
    ...(timeHit?.dayOffset ? { timeDayOffset: timeHit.dayOffset } : {}),
    matchedText: spans.map((span) => span.text).join(" "),
    spans,
  };
}
