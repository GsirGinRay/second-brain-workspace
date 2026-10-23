import assert from "node:assert/strict";
import test from "node:test";
import fixture from "../../../docs/fixtures/inbox-envelope-v1.json" with { type: "json" };
import snapshotFixture from "../../../docs/fixtures/inbox-snapshot-v1.json" with { type: "json" };
import { importInboxPrivateKey, openInboxItem, type InboxSnapshot, type SnapshotTask } from "@second-brain/brain-core";
import {
  classifyStatus,
  createCompleteEntry,
  createEntry,
  fetchSnapshot,
  groupSnapshot,
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
  const entry = await createCompleteEntry(pairing, { id: "task-1", title: "繳電話費" }, new Date("2026-10-23T09:30:00.000Z"));
  assert.equal(entry.completes, "task-1");
  const payload = await open(entry);
  assert.deepEqual(payload, {
    v: 1, text: "繳電話費", createdAt: "2026-10-23T09:30:00.000Z", source: "pwa", action: "complete", taskId: "task-1",
  });
  const moved: Pairing = { ...pairing, inboxId: "BBECAwQFBgcICQoLDA0ODw" };
  const [resealed] = await resealQueued(moved, [entry]);
  assert.equal((await open(resealed!, moved)).taskId, "task-1");
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

test("the today list groups the focus task, overdue, today and coming days", () => {
  const snapshot = snapshotFixture.snapshot as InboxSnapshot;
  const task = (id: string, date: string | null, priority: SnapshotTask["priority"] = "normal"): SnapshotTask => ({
    id, title: id, date, time: null, durationMinutes: null, priority, status: "todo", project: null,
  });
  const groups = groupSnapshot(
    {
      ...snapshot,
      tasks: [
        task("focus", "2026-10-23", "highest"),
        task("today", "2026-10-23"),
        task("late", "2026-10-21"),
        task("soon", "2026-10-25"),
        task("ticked", "2026-10-23"),
        { ...task("done", "2026-10-23"), status: "done" },
      ],
    },
    new Set(["ticked"]),
  );
  assert.equal(groups.focus?.id, "focus");
  assert.deepEqual(groups.today.map((item) => item.id), ["today"]);
  assert.deepEqual(groups.overdue.map((item) => item.id), ["late"]);
  assert.deepEqual(groups.upcoming, [{ date: "2026-10-25", tasks: [task("soon", "2026-10-25")] }]);
});
