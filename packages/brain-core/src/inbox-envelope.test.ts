import assert from "node:assert/strict";
import test from "node:test";
import fixture from "../../../docs/fixtures/inbox-envelope-v1.json" with { type: "json" };
import {
  INBOX_TEXT_BYTES_LIMIT,
  decodeBase64Url,
  encodeBase64Url,
  encodeInboxPayload,
  importInboxPrivateKey,
  inboxAssociatedData,
  openInboxItem,
  parseInboxEnvelope,
  sealInboxItem,
  type InboxPayload,
} from "./inbox-envelope";

const payload = fixture.payload as InboxPayload;

function recipientKey(): Promise<CryptoKey> {
  return importInboxPrivateKey(fixture.recipient.privateScalarBase64Url, fixture.recipient.publicKeyBase64Url);
}

async function freshEnvelope(text = payload.text) {
  return sealInboxItem({
    recipientPublicKey: fixture.recipient.publicKeyBase64Url,
    inboxId: fixture.inboxId,
    itemId: fixture.itemId,
    payload: { ...payload, text },
  });
}

test("sealing with the fixture's ephemeral key and nonce reproduces the golden envelope", async () => {
  assert.equal(new TextDecoder().decode(encodeInboxPayload(payload)), fixture.plaintextUtf8);
  assert.equal(
    new TextDecoder().decode(inboxAssociatedData(fixture.inboxId, fixture.itemId)),
    fixture.associatedDataUtf8,
  );
  const envelope = await sealInboxItem(
    {
      recipientPublicKey: fixture.recipient.publicKeyBase64Url,
      inboxId: fixture.inboxId,
      itemId: fixture.itemId,
      payload,
    },
    {
      ephemeralPrivateKey: await importInboxPrivateKey(
        fixture.ephemeral.privateScalarBase64Url,
        fixture.ephemeral.publicKeyBase64Url,
      ),
      ephemeralPublicKey: fixture.ephemeral.publicKeyBase64Url,
      nonce: decodeBase64Url(fixture.envelope.nonce),
    },
  );
  assert.deepEqual(envelope, fixture.envelope);
});

test("the golden envelope opens with the recipient key", async () => {
  const opened = await openInboxItem(
    fixture.envelope,
    fixture.inboxId,
    await recipientKey(),
    fixture.recipient.publicKeyBase64Url,
  );
  assert.deepEqual(opened, payload);
});

test("fresh envelopes use a new ephemeral key and nonce each time and still open", async () => {
  const first = await freshEnvelope();
  const second = await freshEnvelope();
  assert.notEqual(first.epk, second.epk);
  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(first.ct, second.ct);
  const opened = await openInboxItem(second, fixture.inboxId, await recipientKey(), fixture.recipient.publicKeyBase64Url);
  assert.equal(opened.text, payload.text);
});

test("an envelope cannot be replayed under another inbox or item id", async () => {
  const key = await recipientKey();
  await assert.rejects(
    openInboxItem(fixture.envelope, "BBECAwQFBgcICQoLDA0ODw", key, fixture.recipient.publicKeyBase64Url),
  );
  await assert.rejects(
    openInboxItem(
      { ...fixture.envelope, id: "22222222-2222-4222-8222-222222222222" },
      fixture.inboxId,
      key,
      fixture.recipient.publicKeyBase64Url,
    ),
  );
});

test("a tampered ciphertext is rejected", async () => {
  const bytes = decodeBase64Url(fixture.envelope.ct);
  bytes[0] ^= 0x01;
  await assert.rejects(
    openInboxItem(
      { ...fixture.envelope, ct: encodeBase64Url(bytes) },
      fixture.inboxId,
      await recipientKey(),
      fixture.recipient.publicKeyBase64Url,
    ),
  );
});

test("envelope shape is validated before decrypting", () => {
  assert.throws(() => parseInboxEnvelope({ ...fixture.envelope, extra: true }));
  assert.throws(() => parseInboxEnvelope({ ...fixture.envelope, nonce: "AAEC" }));
  assert.throws(() => parseInboxEnvelope({ ...fixture.envelope, epk: fixture.envelope.nonce }));
  assert.throws(() => parseInboxEnvelope({ ...fixture.envelope, id: "not-a-uuid" }));
});

test("task text is normalized and limited by UTF-8 bytes", async () => {
  const envelope = await freshEnvelope("  第一行\r\n第二行  ");
  const opened = await openInboxItem(envelope, fixture.inboxId, await recipientKey(), fixture.recipient.publicKeyBase64Url);
  assert.equal(opened.text, "第一行\n第二行");

  await assert.rejects(freshEnvelope("   "), /empty/);
  await freshEnvelope("a".repeat(INBOX_TEXT_BYTES_LIMIT));
  await freshEnvelope("字".repeat(INBOX_TEXT_BYTES_LIMIT / 3));
  await assert.rejects(freshEnvelope("字".repeat(INBOX_TEXT_BYTES_LIMIT / 3 + 1)), /too long/);
});

test("ids are validated before they reach the associated data", () => {
  assert.throws(() => inboxAssociatedData("short", fixture.itemId), /inbox id/);
  assert.throws(() => inboxAssociatedData(fixture.inboxId, "11111111-1111-1111-1111-111111111111"), /item id/);
});

test("a complete action carries the task id and round-trips", async () => {
  const envelope = await sealInboxItem({
    recipientPublicKey: fixture.recipient.publicKeyBase64Url,
    inboxId: fixture.inboxId,
    itemId: fixture.itemId,
    payload: { ...payload, text: "繳電話費", action: "complete", taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  });
  const opened = await openInboxItem(envelope, fixture.inboxId, await recipientKey(), fixture.recipient.publicKeyBase64Url);
  assert.equal(opened.action, "complete");
  assert.equal(opened.taskId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  assert.throws(() => encodeInboxPayload({ ...payload, action: "complete" }));
  assert.throws(() => encodeInboxPayload({ ...payload, taskId: "x" }));
});

test("reschedule needs a date; only added tasks carry a project", () => {
  const taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const decoded = (value: object) => JSON.parse(new TextDecoder().decode(encodeInboxPayload(value as never)));
  assert.deepEqual(
    Object.keys(decoded({ ...payload, action: "reschedule", taskId, date: "2026-10-24" })),
    ["v", "text", "createdAt", "source", "action", "taskId", "date"],
  );
  assert.equal(decoded({ ...payload, action: "focus", taskId }).action, "focus");
  assert.deepEqual(decoded({ ...payload, projectId: "p1", date: "2026-10-25" }).projectId, "p1");
  assert.throws(() => encodeInboxPayload({ ...payload, action: "reschedule", taskId }));
  assert.throws(() => encodeInboxPayload({ ...payload, action: "complete", taskId, date: "2026-10-24" }));
  assert.throws(() => encodeInboxPayload({ ...payload, action: "focus", taskId, projectId: "p1" }));
  assert.throws(() => encodeInboxPayload({ ...payload, date: "10/24" }));
  assert.throws(() => encodeInboxPayload({ ...payload, action: "delete" as never, taskId }));
});
