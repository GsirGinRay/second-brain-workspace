import assert from "node:assert/strict";
import test from "node:test";
import type { BrainProjectSnapshot, BrainTaskSnapshot } from "@second-brain/brain-core";
import {
  applyInboxItems,
  buildTodaySnapshot,
  inboxItemsToTasks,
  notesPreview,
  validateInboxRelayEntitlement,
  qrDataUrl,
  validateInboxRelayItems,
  validateInboxRelayPairing,
  validateInboxRelayStatus,
  type InboxRelayItem,
} from "./inbox-relay";

const TODAY = "2026-10-23";

const item = (text: string, patch: Partial<InboxRelayItem> = {}): InboxRelayItem => ({
  id: "11111111-1111-4111-8111-111111111111",
  text,
  createdAt: "2026-10-23T09:30:00.000Z",
  source: "pwa",
  ...patch,
});

test("phone text with a date and time becomes a scheduled inbox task", () => {
  const [task] = inboxItemsToTasks([item("明天下午三點 繳電話費")], TODAY);
  assert.ok(task);
  assert.equal(task.title, "繳電話費");
  assert.equal(task.taskDate, "2026-10-24");
  assert.equal(task.startTime, "15:00");
  assert.equal(task.durationMinutes, 30);
  assert.equal(task.projectId, null);
  assert.equal(task.sourcePath, null);
  assert.equal(task.status, "todo");
});

test("phone text without a date stays undated, a time alone means today", () => {
  const [undated, timed] = inboxItemsToTasks(
    [
      item("買牛奶"),
      item("下午三點 開會", { id: "22222222-2222-4222-8222-222222222222", createdAt: "2026-10-23T09:31:00.000Z" }),
    ],
    TODAY,
  );
  assert.equal(undated?.title, "買牛奶");
  assert.equal(undated?.taskDate, null);
  assert.equal(undated?.startTime, null);
  assert.equal(timed?.taskDate, TODAY);
  assert.equal(timed?.startTime, "15:00");
});

test("a duration without a start time keeps its words, like quick add", () => {
  const [task] = inboxItemsToTasks([item("讀書 30分鐘")], TODAY);
  assert.equal(task?.title, "讀書 30分鐘");
  assert.equal(task?.durationMinutes, null);
});

test("repeat phrases and extra lines are kept", () => {
  const [task] = inboxItemsToTasks([item("每週一 倒垃圾\n記得回收\n  ")], TODAY);
  assert.equal(task?.title, "倒垃圾");
  assert.ok(task?.recurrence);
  assert.ok(task?.taskDate);
  assert.equal(task?.body, "記得回收");
});

test("items are written in the order they were sent, with distinct ids", () => {
  const tasks = inboxItemsToTasks(
    [
      item("第二", { id: "22222222-2222-4222-8222-222222222222", createdAt: "2026-10-23T10:00:00.000Z" }),
      item("第一", { createdAt: "2026-10-23T09:00:00.000Z" }),
    ],
    TODAY,
  );
  assert.deepEqual(tasks.map((task) => task.title), ["第一", "第二"]);
  assert.notEqual(tasks[0]?.id, tasks[1]?.id);
});

test("native responses are validated", () => {
  assert.deepEqual(
    validateInboxRelayStatus({ paired: true, needsRepair: false, connection: "connected", origin: "https://inbox.aizbrain.com", pending: 2, discarded: 0 }),
    { paired: true, needsRepair: false, connection: "connected", origin: "https://inbox.aizbrain.com", pending: 2, discarded: 0 },
  );
  assert.throws(() => validateInboxRelayStatus({ paired: true, needsRepair: false, connection: "weird", origin: "", pending: 0, discarded: 0 }));
  assert.throws(() => validateInboxRelayStatus({ paired: true, needsRepair: false, connection: null, origin: "", pending: -1, discarded: 0 }));

  const url = "https://inbox.aizbrain.com/#v=1&i=AAECAwQFBgcICQoLDA0ODw&t=abc_-123&k=BMK9N3liFox8";
  assert.equal(validateInboxRelayPairing({ url, qrSvg: "<?xml version=\"1.0\"?><svg/>" }).url, url);
  assert.throws(() => validateInboxRelayPairing({ url: "https://evil.example/?t=x", qrSvg: "<?xml" }));
  assert.throws(() => validateInboxRelayPairing({ url, qrSvg: "<script>" }));

  assert.equal(validateInboxRelayItems([item("a")]).length, 1);
  assert.throws(() => validateInboxRelayItems([item("a", { id: "nope" })]));
  assert.throws(() => validateInboxRelayItems([item("   ")]));
  assert.throws(() => validateInboxRelayItems([{ ...item("a"), source: "fax" }]));
  assert.throws(() => validateInboxRelayItems({}));
});

test("the QR SVG is shown through an encoded data URL", () => {
  assert.equal(qrDataUrl("<svg a=\"#\"/>"), "data:image/svg+xml;charset=utf-8,%3Csvg%20a%3D%22%23%22%2F%3E");
});

const base: BrainTaskSnapshot = {
  schemaVersion: 5,
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  title: "繳電話費",
  status: "todo",
  taskDate: TODAY,
  priority: "normal",
  projectId: null,
  projectName: null,
  rank: "m",
  sourcePath: null,
  sourceHeading: null,
  completedAt: null,
  startTime: null,
  durationMinutes: null,
};

const project = (id: string, name: string, patch: Partial<BrainProjectSnapshot> = {}): BrainProjectSnapshot => ({
  id, name, sourcePath: null, status: "active", area: null, priority: null, progress: null, focusToday: false, ...patch,
});

test("the today snapshot holds open tasks from overdue to seven days ahead, without notes", () => {
  const tasks: BrainTaskSnapshot[] = [
    { ...base, id: "t1", title: "今天普通", rank: "b" },
    { ...base, id: "t2", title: "今天最重要", priority: "highest", startTime: "15:00", durationMinutes: 30 },
    { ...base, id: "t3", title: "逾期", taskDate: "2026-10-20", projectName: "業務" },
    { ...base, id: "t4", title: "七天後", taskDate: "2026-10-30" },
    { ...base, id: "t5", title: "八天後", taskDate: "2026-10-31" },
    { ...base, id: "t6", title: "已完成", status: "done", completedAt: TODAY },
    { ...base, id: "t7", title: "沒日期", taskDate: null },
    { ...base, id: "t8", title: "有筆記", body: "私人筆記內容" },
  ];
  const snapshot = buildTodaySnapshot(tasks, TODAY, { now: new Date("2026-10-23T08:00:00.000Z") });
  assert.equal(snapshot.today, TODAY);
  assert.equal(snapshot.generatedAt, "2026-10-23T08:00:00.000Z");
  assert.equal(snapshot.doneToday, 1);
  assert.deepEqual(snapshot.features, ["reschedule", "focus", "add-options"]);
  assert.deepEqual(snapshot.tasks.map((task) => task.title), ["逾期", "今天最重要", "今天普通", "有筆記", "七天後"]);
  assert.deepEqual(snapshot.tasks[1], {
    id: "t2", title: "今天最重要", date: TODAY, time: "15:00", durationMinutes: 30, priority: "highest", status: "todo", project: null,
  });
  assert.equal(snapshot.tasks[0]?.project, "業務");
  assert.ok(!JSON.stringify(snapshot).includes("私人筆記內容"));
});

test("notes, repeats and open projects reach the phone when allowed", () => {
  const long = `${"字".repeat(199)}😀尾`;
  const tasks: BrainTaskSnapshot[] = [
    { ...base, id: "t1", body: "  第一行\r\n\r\n\r\n\r\n第二行  ", recurrence: "every day" },
    { ...base, id: "t2", body: long },
  ];
  const snapshot = buildTodaySnapshot(tasks, TODAY, {
    includeNotes: true,
    projects: [
      project("p2", "乙"),
      project("p1", "甲", { focusToday: true }),
      project("p3", "已結束", { status: "done" }),
      project("", "沒有 id"),
    ],
  });
  assert.equal(snapshot.tasks[0]?.notes, "第一行\n\n第二行");
  assert.equal(snapshot.tasks[0]?.recurrence, "every day");
  assert.equal(snapshot.tasks[1]?.notes, "字".repeat(199), "a split emoji is left out rather than cut in half");
  assert.deepEqual(snapshot.projects, [{ id: "p1", name: "甲" }, { id: "p2", name: "乙" }]);
  assert.equal(notesPreview("   "), undefined);
});

test("a huge snapshot drops notes and then the furthest tasks to fit the relay", () => {
  const tasks: BrainTaskSnapshot[] = Array.from({ length: 300 }, (_, index) => ({
    ...base,
    id: `t${index}`,
    title: "長".repeat(200),
    body: "筆".repeat(300),
    rank: String(index).padStart(3, "0"),
  }));
  const snapshot = buildTodaySnapshot(tasks, TODAY, { includeNotes: true });
  assert.ok(snapshot.tasks.length < 300);
  assert.ok(snapshot.tasks.every((task) => task.notes === undefined));
  assert.ok(new TextEncoder().encode(JSON.stringify(snapshot)).byteLength <= 90_000);
});

test("phone reschedules keep the time, focus demotes today's other most important task", () => {
  const tasks: BrainTaskSnapshot[] = [
    { ...base, id: "a", startTime: "09:00", durationMinutes: 30 },
    { ...base, id: "b", priority: "highest" },
    { ...base, id: "c", taskDate: "2026-10-20" },
  ];
  const next = applyInboxItems(tasks, [
    item("a", { id: "11111111-1111-4111-8111-111111111111", action: "reschedule", taskId: "a", date: "2026-10-25", createdAt: "2026-10-23T01:00:00.000Z" }),
    item("c", { id: "22222222-2222-4222-8222-222222222222", action: "focus", taskId: "c", createdAt: "2026-10-23T01:00:01.000Z" }),
  ], TODAY);
  assert.equal(next[0]?.taskDate, "2026-10-25");
  assert.equal(next[0]?.startTime, "09:00");
  assert.equal(next[1]?.priority, "high");
  assert.equal(next[2]?.priority, "highest");
  assert.equal(next[2]?.taskDate, TODAY);
});

test("changes apply in the order they were made", () => {
  const next = applyInboxItems([base], [
    item("x", { id: "22222222-2222-4222-8222-222222222222", action: "reschedule", taskId: base.id!, date: "2026-10-26", createdAt: "2026-10-23T02:00:00.000Z" }),
    item("x", { id: "11111111-1111-4111-8111-111111111111", action: "complete", taskId: base.id!, createdAt: "2026-10-23T01:00:00.000Z" }),
  ], TODAY);
  assert.equal(next[0]?.status, "done");
  assert.equal(next[0]?.taskDate, TODAY, "a reschedule after the tick is ignored");
});

test("a task added with a picked date and project goes there", () => {
  const [added] = applyInboxItems([], [item("明天 買牛奶", { date: "2026-10-28", projectId: "p1" })], TODAY, [project("p1", "家務")]);
  assert.equal(added?.title, "買牛奶");
  assert.equal(added?.taskDate, "2026-10-28");
  assert.equal(added?.projectId, "p1");
  assert.equal(added?.projectName, "家務");
  const [unknown] = applyInboxItems([], [item("買蛋", { projectId: "gone" })], TODAY, [project("p1", "家務")]);
  assert.equal(unknown?.projectId, null);
});

test("phone ticks mark tasks done and other items become new tasks", () => {
  const tasks = [base, { ...base, id: "done-already", status: "done" as const, completedAt: "2026-10-01" }];
  const next = applyInboxItems(
    tasks,
    [
      item("繳電話費", { action: "complete", taskId: base.id! }),
      item("完成過的", { id: "22222222-2222-4222-8222-222222222222", action: "complete", taskId: "done-already" }),
      item("找不到的", { id: "33333333-3333-4333-8333-333333333333", action: "complete", taskId: "missing" }),
      item("買牛奶", { id: "44444444-4444-4444-8444-444444444444" }),
    ],
    TODAY,
  );
  assert.equal(next.length, 3);
  assert.equal(next[0]?.status, "done");
  assert.equal(next[0]?.completedAt, TODAY);
  assert.equal(next[1]?.completedAt, "2026-10-01", "an already finished task keeps its date");
  assert.equal(next[2]?.title, "買牛奶");
});

test("complete items and entitlements are validated", () => {
  assert.equal(validateInboxRelayItems([item("x", { action: "complete", taskId: "t1" })])[0]?.taskId, "t1");
  assert.throws(() => validateInboxRelayItems([item("x", { action: "complete" })]));
  assert.throws(() => validateInboxRelayItems([{ ...item("x"), taskId: "t1" }]));
  const moved = validateInboxRelayItems([item("x", { action: "reschedule", taskId: "t1", date: "2026-10-24" })])[0];
  assert.equal(moved?.date, "2026-10-24");
  assert.equal(validateInboxRelayItems([item("x", { projectId: "p1", date: "2026-10-24" })])[0]?.projectId, "p1");
  assert.throws(() => validateInboxRelayItems([item("x", { action: "reschedule", taskId: "t1" })]));
  assert.throws(() => validateInboxRelayItems([item("x", { action: "focus", taskId: "t1", date: "2026-10-24" })]));
  assert.throws(() => validateInboxRelayItems([item("x", { action: "focus", taskId: "t1", projectId: "p1" })]));
  assert.throws(() => validateInboxRelayItems([item("x", { date: "2026-02-30" })]));
  assert.throws(() => validateInboxRelayItems([{ ...item("x"), action: "delete", taskId: "t1" }]));
  assert.deepEqual(validateInboxRelayEntitlement({ entitled: true, email: "a@b.co", error: null }), { entitled: true, email: "a@b.co", error: null });
  assert.deepEqual(validateInboxRelayEntitlement({ entitled: false, error: "not_member" }), { entitled: false, email: null, error: "not_member" });
  assert.throws(() => validateInboxRelayEntitlement({ entitled: false, error: "<b>" }));
  const withViewKey = `https://inbox.aizbrain.com/#v=1&i=AAECAwQFBgcICQoLDA0ODw&t=abc&k=BMK9&s=${"A".repeat(43)}`;
  assert.equal(validateInboxRelayPairing({ url: withViewKey, qrSvg: "<?xml" }).url, withViewKey);
});
