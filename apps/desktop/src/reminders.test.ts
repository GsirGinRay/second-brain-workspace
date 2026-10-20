import assert from "node:assert/strict";
import test from "node:test";
import type { BrainTaskSnapshot } from "@second-brain/brain-core";
import {
  DEFAULT_REMINDER_SETTINGS,
  dueReminders,
  loadFiredReminders,
  loadReminderSettings,
  normalizeReminderSettings,
  saveFiredReminders,
} from "./reminders";

const task = (patch: Partial<BrainTaskSnapshot> = {}): BrainTaskSnapshot => ({
  id: "t1",
  title: "客戶會議",
  status: "todo",
  taskDate: "2026-10-20",
  priority: "normal",
  projectId: null,
  projectName: "業務",
  rank: "a",
  sourcePath: null,
  sourceHeading: null,
  completedAt: null,
  startTime: "15:00",
  durationMinutes: 60,
  timeZone: "Asia/Taipei",
  ...patch,
});

// Taipei wall-clock time on 2026-10-20.
const at = (time: string) => new Date(`2026-10-20T${time}:00+08:00`);
const noDigest = { ...DEFAULT_REMINDER_SETTINGS, digestTime: null };

test("a timed task reminds once, lead minutes before it starts", () => {
  assert.deepEqual(dueReminders([task()], at("14:49"), noDigest, new Set(), "zh-TW"), []);
  const due = dueReminders([task()], at("14:50"), noDigest, new Set(), "zh-TW");
  assert.equal(due.length, 1);
  assert.equal(due[0]!.title, "客戶會議");
  assert.equal(due[0]!.body, "10 分鐘後開始（15:00） · 業務");
  assert.deepEqual(dueReminders([task()], at("14:55"), noDigest, new Set([due[0]!.key]), "zh-TW"), []);
});

test("a late reminder still fires until shortly after the start, with the real time left", () => {
  assert.equal(dueReminders([task()], at("15:29"), noDigest, new Set(), "en")[0]?.body, "Starting now (15:00) · 業務");
  assert.equal(dueReminders([task()], at("15:31"), noDigest, new Set(), "en").length, 0);
  // An hour-ahead reminder seen only 20 minutes before (the PC just woke up).
  const late = dueReminders([task()], at("14:40"), { ...noDigest, leadMinutes: 60 }, new Set(), "zh-TW");
  assert.equal(late[0]?.body, "20 分鐘後開始（15:00） · 業務");
});

test("done, untimed and undated tasks never remind; disabled settings mute all", () => {
  const tasks = [task({ status: "done" }), task({ id: "t2", startTime: null }), task({ id: "t3", taskDate: null })];
  assert.deepEqual(dueReminders(tasks, at("14:50"), noDigest, new Set(), "en"), []);
  assert.deepEqual(dueReminders([task()], at("14:50"), { ...noDigest, enabled: false }, new Set(), "en"), []);
});

test("changing a task's time gives it a fresh reminder", () => {
  const first = dueReminders([task()], at("14:50"), noDigest, new Set(), "en")[0]!;
  const moved = dueReminders([task({ startTime: "16:00" })], at("15:50"), noDigest, new Set([first.key]), "en");
  assert.equal(moved.length, 1);
});

test("the daily summary fires once after its time with today's counts", () => {
  const tasks = [
    task({ id: "a", startTime: null, priority: "highest", title: "寫提案" }),
    task({ id: "b", startTime: null }),
    task({ id: "c", startTime: null, taskDate: "2026-10-18" }),
    task({ id: "d", startTime: null, status: "done" }),
  ];
  const settings = { ...DEFAULT_REMINDER_SETTINGS, digestTime: "09:00" };
  assert.deepEqual(dueReminders(tasks, at("08:59"), settings, new Set(), "zh-TW"), []);
  const [digest] = dueReminders(tasks, at("09:00"), settings, new Set(), "zh-TW");
  assert.equal(digest?.key, "digest:2026-10-20");
  assert.equal(digest?.body, "今天 2 件，逾期 1 件。最重要：寫提案");
  assert.deepEqual(dueReminders(tasks, at("13:00"), settings, new Set(["digest:2026-10-20"]), "zh-TW"), []);
  assert.deepEqual(dueReminders([], at("09:00"), settings, new Set(), "zh-TW"), []);
  // Opening the app in the afternoon does not announce the morning summary.
  assert.deepEqual(dueReminders(tasks, at("12:01"), settings, new Set(), "zh-TW"), []);
});

test("settings are validated and storage failures fall back safely", () => {
  assert.deepEqual(normalizeReminderSettings({ enabled: false, leadMinutes: 7, digestTime: "9am" }), { ...DEFAULT_REMINDER_SETTINGS, enabled: false });
  assert.deepEqual(normalizeReminderSettings({ digestTime: null }), { ...DEFAULT_REMINDER_SETTINGS, digestTime: null });
  const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.deepEqual(loadReminderSettings(broken), DEFAULT_REMINDER_SETTINGS);
  assert.deepEqual(loadFiredReminders(broken), []);
  assert.doesNotThrow(() => saveFiredReminders(broken, ["x"]));
});
