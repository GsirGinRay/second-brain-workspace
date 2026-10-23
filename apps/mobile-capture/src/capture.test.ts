import assert from "node:assert/strict";
import test from "node:test";
import fixture from "../../../docs/fixtures/inbox-envelope-v1.json" with { type: "json" };
import snapshotFixture from "../../../docs/fixtures/inbox-snapshot-v1.json" with { type: "json" };
import { importInboxPrivateKey, openInboxItem, type InboxSnapshot, type SnapshotTask } from "@second-brain/brain-core";
import {
  addDays,
  applyLocalChanges,
  classifyStatus,
  createChangeEntry,
  createEntry,
  effectiveToday,
  endTime,
  fetchSnapshot,
  groupSnapshot,
  loadView,
  nextMonday,
  saveView,
  todayProgress,
  pairingFragment,
  type JsonFetcher,
  flushOutbox,
  isTextWithinLimit,
  loadOutbox,
  loadPairing,
  parsePairingFragment,
  resealQueued,
  saveOutbox,
  savePairing,
  type Fetcher,
  type KeyValueStore,
  type OutboxEntry,
  type Pairing,
} from "./capture";

const pairing: Pairing = {
  inboxId: fixture.inboxId,
  token: "capture-token-0123456789",
  publicKey: fixture.recipient.publicKeyBase64Url,
};

function memoryStore(): KeyValueStore {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
  };
}

async function open(entry: OutboxEntry, inbox = pairing) {
  const key = await importInboxPrivateKey(fixture.recipient.privateScalarBase64Url, fixture.recipient.publicKeyBase64Url);
  return openInboxItem(entry.envelope, inbox.inboxId, key, fixture.recipient.publicKeyBase64Url);
}

test("the QR fragment is parsed strictly", () => {
  const fragment = `#v=1&i=${pairing.inboxId}&t=${pairing.token}&k=${pairing.publicKey}`;
  assert.deepEqual(parsePairingFragment(fragment), pairing);
  assert.equal(parsePairingFragment(""), null);
  assert.equal(parsePairingFragment(fragment.replace("v=1", "v=2")), null);
  assert.equal(parsePairingFragment(fragment.replace(pairing.inboxId, "short")), null);
  assert.equal(parsePairingFragment(fragment.replace(pairing.publicKey, fixture.envelope.nonce)), null);
  assert.equal(parsePairingFragment(fragment.replace(pairing.token, "bad token!")), null);
});

test("pairing and outbox survive a reload", async () => {
  const store = memoryStore();
  assert.equal(loadPairing(store), null);
  savePairing(store, pairing);
  assert.deepEqual(loadPairing(store), pairing);
  store.setItem("second-brain.capture.pairing", "{broken");
  assert.equal(loadPairing(store), null);

  const entry = await createEntry(pairing, "  明天下午三點 繳電話費  ");
  saveOutbox(store, [entry]);
  assert.deepEqual(loadOutbox(store), [entry]);
});

test("items are sealed for the paired computer before they are queued", async () => {
  const entry = await createEntry(pairing, "明天下午三點 繳電話費", new Date("2026-10-23T09:30:00.000Z"));
  assert.equal(entry.state, "queued");
  assert.equal(entry.envelope.id, entry.id);
  assert.ok(!JSON.stringify(entry.envelope).includes("繳電話費"));
  const payload = await open(entry);
  assert.deepEqual(payload, { v: 1, text: "明天下午三點 繳電話費", createdAt: "2026-10-23T09:30:00.000Z", source: "pwa" });
});

test("only sent history is trimmed; queued items are kept", async () => {
  const store = memoryStore();
  const base = await createEntry(pairing, "x");
  const entries: OutboxEntry[] = Array.from({ length: 30 }, (_, index) => ({ ...base, id: `id-${index}`, state: "sent" as const }));
  entries.push({ ...base, id: "queued", state: "queued" });
  saveOutbox(store, entries);
  const kept = loadOutbox(store);
  assert.equal(kept.length, 21);
  assert.ok(kept.some((entry) => entry.id === "queued"));
  assert.equal(kept[0]?.id, "id-10");
});

test("upload statuses map onto the outbox", () => {
  assert.equal(classifyStatus(201), "sent");
  assert.equal(classifyStatus(200), "sent");
  assert.equal(classifyStatus(401), "unpaired");
  assert.equal(classifyStatus(404), "unpaired");
  assert.equal(classifyStatus(409), "failed");
  assert.equal(classifyStatus(413), "failed");
  assert.equal(classifyStatus(429), "retry");
  assert.equal(classifyStatus(503), "retry");
});

test("flushing sends in order and stops at the first item to retry", async () => {
  const entries = await Promise.all(["一", "二", "三"].map((text) => createEntry(pairing, text)));
  const requests: { url: string; init: RequestInit }[] = [];
  const statuses = [201, 503];
  const fetcher: Fetcher = async (url, init) => {
    requests.push({ url, init });
    return { status: statuses.shift() ?? 201 };
  };
  const first = await flushOutbox("https://inbox.example", pairing, entries, fetcher);
  assert.deepEqual(first.entries.map((entry) => entry.state), ["sent", "queued", "queued"]);
  assert.equal(first.sent, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.url, `https://inbox.example/v1/inboxes/${pairing.inboxId}/items`);
  const headers = requests[0]?.init.headers as Record<string, string>;
  assert.equal(headers.authorization, `Bearer ${pairing.token}`);
  assert.equal(requests[0]?.init.credentials, "omit");
  assert.deepEqual(JSON.parse(String(requests[0]?.init.body)), entries[0]?.envelope);

  const second = await flushOutbox("https://inbox.example", pairing, first.entries, fetcher);
  assert.deepEqual(second.entries.map((entry) => entry.state), ["sent", "sent", "sent"]);
  assert.equal(requests.length, 4);
});

test("network errors retry and a revoked token reports unpaired", async () => {
  const [entry] = [await createEntry(pairing, "一")];
  const offline = await flushOutbox("https://inbox.example", pairing, [entry!], async () => { throw new TypeError("offline"); });
  assert.equal(offline.entries[0]?.state, "queued");
  assert.equal(offline.unpaired, false);
  const revoked = await flushOutbox("https://inbox.example", pairing, [entry!], async () => ({ status: 401 }));
  assert.equal(revoked.entries[0]?.state, "queued");
  assert.equal(revoked.unpaired, true);
});

test("queued items are resealed for a new pairing", async () => {
  const sent = { ...(await createEntry(pairing, "已送")), state: "sent" as const };
  const queued = await createEntry(pairing, "未送");
  const moved: Pairing = { ...pairing, inboxId: "BBECAwQFBgcICQoLDA0ODw" };
  const [keptSent, resealed] = await resealQueued(moved, [sent, queued]);
  assert.equal(keptSent, sent);
  assert.equal(resealed?.id, queued.id);
  assert.equal((await open(resealed!, moved)).text, "未送");
  await assert.rejects(open(resealed!, pairing));
});

test("text must be non-empty and within the byte limit", () => {
  assert.equal(isTextWithinLimit("   "), false);
  assert.equal(isTextWithinLimit("買牛奶"), true);
  assert.equal(isTextWithinLimit("字".repeat(801)), false);
});

test("view keys in the QR fragment are kept and validated", () => {
  const viewKey = snapshotFixture.viewKeyBase64Url;
  const fragment = `#v=1&i=${pairing.inboxId}&t=${pairing.token}&k=${pairing.publicKey}&s=${viewKey}`;
  const parsed = parsePairingFragment(fragment);
  assert.equal(parsed?.viewKey, viewKey);
  assert.equal(pairingFragment(parsed!), fragment);
  assert.equal(parsePairingFragment(fragment.replace(viewKey, "short")), null);
  const store = memoryStore();
  savePairing(store, parsed!);
  assert.equal(loadPairing(store)?.viewKey, viewKey);
});

test("a tick is sealed as a complete action for that task", async () => {
  const entry = await createChangeEntry(pairing, { id: "task-1", title: "繳電話費" }, { action: "complete" }, new Date("2026-10-23T09:30:00.000Z"));
  assert.equal(entry.taskId, "task-1");
  assert.equal(entry.holdUntil, Date.parse("2026-10-23T09:30:05.000Z"));
  const payload = await open(entry);
  assert.deepEqual(payload, {
    v: 1, text: "繳電話費", createdAt: "2026-10-23T09:30:00.000Z", source: "pwa", action: "complete", taskId: "task-1",
  });
  const moved: Pairing = { ...pairing, inboxId: "BBECAwQFBgcICQoLDA0ODw" };
  const [resealed] = await resealQueued(moved, [entry]);
  assert.equal((await open(resealed!, moved)).taskId, "task-1");
});

test("reschedules, focus and new-task options are sealed and resealed", async () => {
  const now = new Date("2026-10-23T09:30:00.000Z");
  const moved = await createChangeEntry(pairing, { id: "t", title: "x" }, { action: "reschedule", date: "2026-10-24" }, now);
  assert.equal((await open(moved)).date, "2026-10-24");
  const focus = await createChangeEntry(pairing, { id: "t", title: "x" }, { action: "focus", date: "2026-10-24" }, now, 0);
  assert.equal(focus.holdUntil, undefined);
  assert.equal((await open(focus)).date, undefined, "only a reschedule carries a date");
  const added = await createEntry(pairing, " 買牛奶 ", now, { date: "2026-10-25", projectId: "p1" });
  const other: Pairing = { ...pairing, inboxId: "BBECAwQFBgcICQoLDA0ODw" };
  const [resealed] = await resealQueued(other, [added]);
  assert.deepEqual(await open(resealed!, other), {
    v: 1, text: "買牛奶", createdAt: "2026-10-23T09:30:00.000Z", source: "pwa", date: "2026-10-25", projectId: "p1",
  });
});

test("outboxes from 0.8.0 keep their ticks", () => {
  const store = memoryStore();
  store.setItem("second-brain.capture.outbox", JSON.stringify([{ id: "a", text: "x", createdAt: "2026-10-23T09:30:00.000Z", state: "sent", envelope: {}, completes: "t1" }]));
  const [entry] = loadOutbox(store);
  assert.equal(entry?.action, "complete");
  assert.equal(entry?.taskId, "t1");
  assert.equal("completes" in entry!, false);
});

test("changes inside their undo window wait for a later flush", async () => {
  const now = new Date("2026-10-23T09:30:00.000Z");
  const held = await createChangeEntry(pairing, { id: "t", title: "x" }, { action: "complete" }, now);
  const added = await createEntry(pairing, "買牛奶", now);
  const calls: string[] = [];
  const fetcher: Fetcher = async (_url, init) => {
    calls.push(JSON.parse(String(init.body)).id);
    return { status: 201 };
  };
  const first = await flushOutbox("https://x", pairing, [held, added], fetcher, now.getTime() + 1_000);
  assert.deepEqual(calls, [added.id]);
  assert.equal(first.entries[0]?.state, "queued");
  const later = await flushOutbox("https://x", pairing, first.entries, fetcher, now.getTime() + 5_000);
  assert.deepEqual(calls, [added.id, held.id]);
  assert.equal(later.entries[0]?.state, "sent");
  assert.equal(later.entries[0]?.holdUntil, undefined);
});

test("snapshot responses map onto what the phone shows", async () => {
  const withKey: Pairing = { ...pairing, inboxId: snapshotFixture.inboxId, viewKey: snapshotFixture.viewKeyBase64Url };
  const answer = (status: number, body: unknown): JsonFetcher => async () => ({ status, json: async () => body });
  const ok = await fetchSnapshot("https://inbox.example", withKey, answer(200, snapshotFixture.envelope));
  assert.equal(ok.kind, "ok");
  assert.equal(ok.kind === "ok" && ok.snapshot.tasks[0]?.title, "繳電話費");
  assert.equal((await fetchSnapshot("https://x", withKey, answer(403, { error: "not_entitled" }))).kind, "not_entitled");
  assert.equal((await fetchSnapshot("https://x", withKey, answer(404, { error: "no_snapshot" }))).kind, "none");
  assert.equal((await fetchSnapshot("https://x", withKey, answer(404, { error: "not_found" }))).kind, "unpaired");
  assert.equal((await fetchSnapshot("https://x", withKey, answer(401, {}))).kind, "unpaired");
  assert.equal((await fetchSnapshot("https://x", withKey, answer(200, { ...snapshotFixture.envelope, ct: "AAAA" }))).kind, "error");
  assert.equal((await fetchSnapshot("https://x", withKey, async () => { throw new TypeError("offline"); })).kind, "error");
  assert.equal((await fetchSnapshot("https://x", pairing, answer(200, snapshotFixture.envelope))).kind, "error");
});

const task = (id: string, date: string | null, patch: Partial<SnapshotTask> = {}): SnapshotTask => ({
  id, title: id, date, time: null, durationMinutes: null, priority: "normal", status: "todo", project: null, ...patch,
});

const base = snapshotFixture.snapshot as InboxSnapshot;

test("the today list groups the focus task, overdue, a timeline and coming days", () => {
  const snapshot: InboxSnapshot = {
    ...base,
    tasks: [
      task("focus", "2026-10-23", { priority: "highest" }),
      task("untimed", "2026-10-23"),
      task("late-day", "2026-10-23", { time: "15:00" }),
      task("morning", "2026-10-23", { time: "09:00" }),
      task("late", "2026-10-21"),
      task("soon", "2026-10-25"),
      task("week", "2026-10-30"),
      task("later", "2026-10-31"),
      task("done", "2026-10-23", { status: "done" }),
    ],
  };
  const groups = groupSnapshot(snapshot);
  assert.equal(groups.focus?.id, "focus");
  assert.deepEqual(groups.today.map((item) => item.id), ["morning", "late-day", "untimed"]);
  assert.deepEqual(groups.overdue.map((item) => item.id), ["late"]);
  assert.deepEqual(groups.upcoming.map((day) => day.date), ["2026-10-25"]);
  const week = groupSnapshot(snapshot, { days: 7, project: null });
  assert.deepEqual(week.upcoming.map((day) => day.date), ["2026-10-25", "2026-10-30"]);
});

test("a project filter narrows every group", () => {
  const snapshot: InboxSnapshot = {
    ...base,
    tasks: [task("focus", "2026-10-23", { priority: "highest" }), task("home", "2026-10-23", { project: "家務" })],
  };
  const groups = groupSnapshot(snapshot, { days: 3, project: "家務" });
  assert.equal(groups.focus, null);
  assert.deepEqual(groups.today.map((item) => item.id), ["home"]);
});

test("changes made on the phone show until a newer snapshot includes them", async () => {
  const snapshot: InboxSnapshot = {
    ...base,
    generatedAt: "2026-10-23T09:00:00.000Z",
    doneToday: 2,
    tasks: [
      task("a", "2026-10-23", { priority: "highest" }),
      task("b", "2026-10-23"),
      task("c", "2026-10-23"),
      task("d", "2026-10-21"),
    ],
  };
  const at = (minute: number) => new Date(`2026-10-23T09:${String(minute).padStart(2, "0")}:00.000Z`);
  const tick = await createChangeEntry(pairing, task("d", null), { action: "complete" }, at(1));
  const move = await createChangeEntry(pairing, task("b", null), { action: "reschedule", date: "2026-10-24" }, at(2));
  const star = await createChangeEntry(pairing, task("c", null), { action: "focus" }, at(3));
  const old = await createChangeEntry(pairing, task("a", null), { action: "complete" }, new Date("2026-10-23T08:00:00.000Z"));
  const failed = { ...(await createChangeEntry(pairing, task("a", null), { action: "complete" }, at(4))), state: "failed" as const };

  const view = applyLocalChanges(snapshot, [tick, move, star, old, failed]);
  assert.deepEqual([...view.pending].sort(), ["b", "c", "d"]);
  const byId = new Map(view.snapshot.tasks.map((item) => [item.id, item]));
  assert.equal(byId.get("d")?.status, "done");
  assert.equal(byId.get("b")?.date, "2026-10-24");
  assert.equal(byId.get("c")?.priority, "highest");
  assert.equal(byId.get("a")?.priority, "high", "the old focus steps down");
  assert.equal(byId.get("a")?.status, "todo", "changes older than the snapshot are already in it");
  assert.deepEqual(todayProgress(view), { done: 3, total: 5 });
  assert.equal(snapshot.tasks[1]?.date, "2026-10-23", "the snapshot itself is not changed");

  const newer = applyLocalChanges({ ...snapshot, generatedAt: "2026-10-23T09:10:00.000Z" }, [tick, move, star]);
  assert.equal(newer.pending.size, 0);
});

test("a snapshot from yesterday is read against the phone's today", () => {
  const snapshot: InboxSnapshot = { ...base, today: "2026-10-22", doneToday: 4, tasks: [task("y", "2026-10-22")] };
  const today = effectiveToday(snapshot, new Date(2026, 9, 23, 8));
  assert.equal(today, "2026-10-23");
  assert.deepEqual(groupSnapshot(snapshot, { days: 3, project: null }, today).overdue.map((item) => item.id), ["y"]);
  assert.deepEqual(todayProgress(applyLocalChanges(snapshot, [], today), today), { done: 0, total: 1 });
  assert.equal(effectiveToday({ ...snapshot, today: "2026-10-24" }, new Date(2026, 9, 23, 8)), "2026-10-24");
});

test("date helpers and the saved view", () => {
  assert.equal(addDays("2026-10-31", 1), "2026-11-01");
  assert.equal(nextMonday("2026-10-23"), "2026-10-26");
  assert.equal(nextMonday("2026-10-26"), "2026-11-02");
  assert.equal(endTime("23:45", 30), "00:15");
  const store = memoryStore();
  assert.deepEqual(loadView(store), { days: 3, project: null });
  saveView(store, { days: 7, project: "家務" });
  assert.deepEqual(loadView(store), { days: 7, project: "家務" });
  store.setItem("second-brain.capture.view", "{bad");
  assert.deepEqual(loadView(store), { days: 3, project: null });
});
