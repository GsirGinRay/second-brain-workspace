import assert from "node:assert/strict";
import test from "node:test";
import {
  inboxItemsToTasks,
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
