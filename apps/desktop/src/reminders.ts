import type { BrainTaskSnapshot } from "@second-brain/brain-core";

export interface ReminderSettings {
  enabled: boolean;
  /** Minutes before a timed task's start; 0 notifies at the start time. */
  leadMinutes: number;
  /** Daily summary time (HH:MM, Taipei), or null for no summary. */
  digestTime: string | null;
}

export interface DueReminder {
  key: string;
  title: string;
  body: string;
}

export const REMINDER_SETTINGS_KEY = "second-brain.reminders";
export const FIRED_REMINDERS_KEY = "second-brain.firedReminders";
export const LEAD_MINUTE_OPTIONS = [0, 5, 10, 15, 30, 60] as const;
export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = { enabled: true, leadMinutes: 10, digestTime: "09:00" };

// A reminder that was missed by more than this (app closed, PC asleep) is
// dropped instead of popping up long after it stopped being useful.
const LATE_GRACE_MS = 30 * 60_000;
const DIGEST_WINDOW_MS = 3 * 3_600_000;
const MAX_FIRED_KEYS = 500;
const TAIPEI_OFFSET = "+08:00";
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

type Language = "zh-TW" | "en";
type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

export function normalizeReminderSettings(value: unknown): ReminderSettings {
  const candidate = (value && typeof value === "object" ? value : {}) as Partial<ReminderSettings>;
  return {
    enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : DEFAULT_REMINDER_SETTINGS.enabled,
    leadMinutes: LEAD_MINUTE_OPTIONS.includes(candidate.leadMinutes as typeof LEAD_MINUTE_OPTIONS[number])
      ? candidate.leadMinutes!
      : DEFAULT_REMINDER_SETTINGS.leadMinutes,
    digestTime: candidate.digestTime === null
      ? null
      : typeof candidate.digestTime === "string" && TIME.test(candidate.digestTime)
        ? candidate.digestTime
        : DEFAULT_REMINDER_SETTINGS.digestTime,
  };
}

export function loadReminderSettings(storage: Storage): ReminderSettings {
  try {
    return normalizeReminderSettings(JSON.parse(storage.getItem(REMINDER_SETTINGS_KEY) ?? "null"));
  } catch {
    return DEFAULT_REMINDER_SETTINGS;
  }
}

export function saveReminderSettings(storage: Storage, settings: ReminderSettings): void {
  try {
    storage.setItem(REMINDER_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Settings still apply for this session.
  }
}

export function loadFiredReminders(storage: Storage): string[] {
  try {
    const value = JSON.parse(storage.getItem(FIRED_REMINDERS_KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function saveFiredReminders(storage: Storage, keys: readonly string[]): void {
  try {
    storage.setItem(FIRED_REMINDERS_KEY, JSON.stringify(keys.slice(-MAX_FIRED_KEYS)));
  } catch {
    // Worst case a reminder repeats after a restart.
  }
}

function taipeiInstant(date: string, time: string): number {
  return Date.parse(`${date}T${time}:00${TAIPEI_OFFSET}`);
}

function taipeiToday(now: Date): string {
  return new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

function taskReminder(task: BrainTaskSnapshot, now: number, lead: number, language: Language): DueReminder | null {
  if (task.status === "done" || !task.id || !task.taskDate || !task.startTime) return null;
  const start = taipeiInstant(task.taskDate, task.startTime);
  if (Number.isNaN(start)) return null;
  const fireAt = start - lead * 60_000;
  // Late is fine until the task starts (e.g. the PC just woke up), then for a
  // short grace period; after that the reminder is no longer useful.
  if (now < fireAt || now > Math.max(fireAt, start) + LATE_GRACE_MS) return null;
  const zh = language === "zh-TW";
  const project = task.projectName ? ` · ${task.projectName}` : "";
  const minutesLeft = Math.round((start - now) / 60_000);
  const when = minutesLeft <= 0
    ? (zh ? `現在開始（${task.startTime}）` : `Starting now (${task.startTime})`)
    : (zh ? `${minutesLeft} 分鐘後開始（${task.startTime}）` : `Starts in ${minutesLeft} min (${task.startTime})`);
  return {
    key: `task:${task.id}:${task.taskDate}:${task.startTime}:${lead}`,
    title: task.title,
    body: `${when}${project}`,
  };
}

function digestReminder(tasks: readonly BrainTaskSnapshot[], now: Date, digestTime: string, language: Language): DueReminder | null {
  const today = taipeiToday(now);
  const fireAt = taipeiInstant(today, digestTime);
  // A summary of "today" is only useful in the morning hours after its time.
  if (now.getTime() < fireAt || now.getTime() > fireAt + DIGEST_WINDOW_MS) return null;
  const open = tasks.filter((task) => task.status !== "done" && task.taskDate);
  const todayCount = open.filter((task) => task.taskDate === today).length;
  const overdueCount = open.filter((task) => task.taskDate! < today).length;
  if (todayCount + overdueCount === 0) return null;
  const top = open.find((task) => task.taskDate === today && task.priority === "highest");
  const zh = language === "zh-TW";
  const counts = zh
    ? `今天 ${todayCount} 件${overdueCount ? `，逾期 ${overdueCount} 件` : ""}`
    : `${todayCount} today${overdueCount ? `, ${overdueCount} overdue` : ""}`;
  return {
    key: `digest:${today}`,
    title: zh ? "今天的任務" : "Today's tasks",
    body: top ? `${counts}${zh ? "。最重要：" : ". Most important: "}${top.title}` : counts,
  };
}

/** Reminders that should show now and have not been shown yet. */
export function dueReminders(
  tasks: readonly BrainTaskSnapshot[],
  now: Date,
  settings: ReminderSettings,
  fired: ReadonlySet<string>,
  language: Language,
): DueReminder[] {
  if (!settings.enabled) return [];
  const due = tasks.flatMap((task) => {
    const reminder = taskReminder(task, now.getTime(), settings.leadMinutes, language);
    return reminder ? [reminder] : [];
  });
  const digest = settings.digestTime ? digestReminder(tasks, now, settings.digestTime, language) : null;
  return [...(digest ? [digest] : []), ...due].filter((reminder) => !fired.has(reminder.key));
}
