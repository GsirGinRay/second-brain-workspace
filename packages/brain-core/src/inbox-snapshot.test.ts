import assert from "node:assert/strict";
import test from "node:test";
import fixture from "../../../docs/fixtures/inbox-snapshot-v1.json" with { type: "json" };
import { decodeBase64Url, encodeBase64Url } from "./inbox-envelope";
import {
  isViewKey,
  openSnapshot,
  parseSnapshot,
  parseSnapshotEnvelope,
  sealSnapshot,
  snapshotAssociatedData,
  type InboxSnapshot,
} from "./inbox-snapshot";

const snapshot = fixture.snapshot as InboxSnapshot;

test("sealing with the fixture nonce reproduces the golden snapshot envelope", async () => {
  assert.equal(JSON.stringify(parseSnapshot(snapshot)), fixture.plaintextUtf8);
  assert.equal(
    new TextDecoder().decode(snapshotAssociatedData(fixture.inboxId, fixture.envelope.version)),
    fixture.associatedDataUtf8,
  );
  const envelope = await sealSnapshot(snapshot, fixture.inboxId, fixture.viewKeyBase64Url, fixture.envelope.version, {
    nonce: decodeBase64Url(fixture.envelope.nonce),
  });
  assert.deepEqual(envelope, fixture.envelope);
});

test("the golden snapshot opens with the view key", async () => {
  assert.deepEqual(await openSnapshot(fixture.envelope, fixture.inboxId, fixture.viewKeyBase64Url), snapshot);
});

test("a snapshot is bound to its inbox and version and rejects tampering", async () => {
  await assert.rejects(openSnapshot(fixture.envelope, "BBECAwQFBgcICQoLDA0ODw", fixture.viewKeyBase64Url));
  await assert.rejects(openSnapshot({ ...fixture.envelope, version: fixture.envelope.version - 1 }, fixture.inboxId, fixture.viewKeyBase64Url));
  const bytes = decodeBase64Url(fixture.envelope.ct);
  bytes[3] ^= 1;
  await assert.rejects(openSnapshot({ ...fixture.envelope, ct: encodeBase64Url(bytes) }, fixture.inboxId, fixture.viewKeyBase64Url));
  const otherKey = encodeBase64Url(new Uint8Array(32).fill(9));
  await assert.rejects(openSnapshot(fixture.envelope, fixture.inboxId, otherKey));
});

test("snapshot contents and envelopes are validated", () => {
  assert.throws(() => parseSnapshot({ ...snapshot, extra: 1 }));
  assert.throws(() => parseSnapshot({ ...snapshot, today: "23/10/2026" }));
  assert.throws(() => parseSnapshot({ ...snapshot, tasks: [{ ...snapshot.tasks[0], status: "lost" }] }));
  assert.throws(() => parseSnapshot({ ...snapshot, tasks: [{ ...snapshot.tasks[0], title: "" }] }));
  assert.throws(() => parseSnapshotEnvelope({ ...fixture.envelope, nonce: "AAEC" }));
  assert.throws(() => parseSnapshotEnvelope({ ...fixture.envelope, version: 0 }));
  assert.equal(isViewKey(fixture.viewKeyBase64Url), true);
  assert.equal(isViewKey("short"), false);
});

test("optional details, progress, projects and features round-trip", async () => {
  const detailed = parseSnapshot({
    ...snapshot,
    tasks: [{ ...snapshot.tasks[0], recurrence: "every day", notes: "帶收據" }],
    doneToday: 2,
    projects: [{ id: "p1", name: "家務" }],
    features: ["reschedule", "focus", "add-options"],
  });
  const sealed = await sealSnapshot(detailed, fixture.inboxId, fixture.viewKeyBase64Url, 6);
  assert.deepEqual(await openSnapshot(sealed, fixture.inboxId, fixture.viewKeyBase64Url), detailed);
  assert.throws(() => parseSnapshot({ ...snapshot, tasks: [{ ...snapshot.tasks[0], notes: "x".repeat(201) }] }));
  assert.throws(() => parseSnapshot({ ...snapshot, features: ["delete"] }));
  assert.throws(() => parseSnapshot({ ...snapshot, doneToday: -1 }));
});

test("fresh seals use a new nonce and round-trip", async () => {
  const first = await sealSnapshot(snapshot, fixture.inboxId, fixture.viewKeyBase64Url, 5);
  const second = await sealSnapshot(snapshot, fixture.inboxId, fixture.viewKeyBase64Url, 5);
  assert.notEqual(first.nonce, second.nonce);
  assert.deepEqual(await openSnapshot(second, fixture.inboxId, fixture.viewKeyBase64Url), snapshot);
});
