# Encrypted Inbox Relay (protocol v1)

The inbox relay lets a phone add tasks to the desktop's `收件匣` while the
computer may be off. It is option A of the mobile plan in
[feature-roadmap.md](feature-roadmap.md). The relay is optional: until a user
pairs a phone, the desktop app never contacts it.

## Properties

- **End-to-end encrypted.** The phone encrypts each item with the desktop's
  inbox public key. The relay stores only ciphertext and cannot read, edit or
  move an item to another inbox.
- **Store until delivered.** The relay deletes an item as soon as the desktop
  confirms it was written to Markdown, and after 14 days at the latest.
- **Add only.** A phone holds a write-only capture token. It cannot list, read
  or delete items.
- **Markdown stays the source of truth.** The desktop writes an item with the
  normal backup and atomic-write path before it acknowledges it.

Hosted instance: `https://inbox.aizbrain.com`. Self-hosters can run
`services/inbox-relay` on their own origin; HTTPS is required except for
localhost development.

## Flow

```text
phone PWA ──seal──► POST /v1/inboxes/{id}/items ──► relay (ciphertext, ≤14 days)
                                                       │ WebSocket push
desktop ◄──────────────────────────────────────────────┘
  open → backup → atomic write to 收件匣 → DELETE item (ack)
```

## Keys and identifiers

| Name | Owner | Format |
| --- | --- | --- |
| Signing key | desktop | Existing Ed25519 device key (`key_store.rs`). Signs every desktop request. |
| Inbox key | desktop | P-256 key pair, separate from the signing key. Private scalar protected with DPAPI; never leaves Rust. |
| Inbox id | relay | 16 random bytes, base64url without padding (22 characters). |
| Capture token | relay → phone | 32 random bytes, base64url. The relay stores only its SHA-256. |
| Item id | phone | Lowercase UUID v4 (`crypto.randomUUID()`). Also the idempotency key. |

All binary values use base64url without padding.

## Envelope

Implemented in `packages/brain-core/src/inbox-envelope.ts` (sealing, used by
the PWA) and `apps/desktop/src-tauri/src/inbox_envelope.rs` (opening). Both
are locked to `docs/fixtures/inbox-envelope-v1.json`; changing any byte of
the format requires a new version and a new fixture.

1. The sender generates an ephemeral P-256 key pair for every item.
2. `shared` = ECDH(ephemeral private, inbox public), the 32-byte x-coordinate.
3. `key` = HKDF-SHA256(ikm = `shared`, salt = `epk ‖ inboxPublicKey`,
   info = `second-brain-inbox-v1`, 32 bytes). Both public keys are 65-byte
   uncompressed SEC1 points.
4. `ct` = AES-256-GCM(key, 12-byte random nonce, plaintext, aad), with the
   16-byte tag appended.
5. `aad` = UTF-8 `v1\n<inboxId>\n<itemId>`. It binds the ciphertext to one
   inbox and one item id.

```json
{ "v": 1, "id": "<itemId>", "epk": "<65 bytes>", "nonce": "<12 bytes>", "ct": "<ciphertext+tag>" }
```

Plaintext is UTF-8 JSON with this exact key order:

```json
{ "v": 1, "text": "明天下午三點 繳電話費", "createdAt": "2026-10-23T09:30:00.000Z", "source": "pwa" }
```

- `text` is trimmed, CRLF becomes LF, it must not be empty, and it is at most
  2400 UTF-8 bytes (about 800 Chinese characters). The desktop parses dates
  and tokens from it the same way as quick add.
- `source` is `pwa`, `line` or `email`. LINE and email items arrive at the
  relay in plain text; the relay seals them with the inbox public key on
  arrival and stores only the envelope.
- The serialized envelope must be at most 4096 bytes.

## Pairing

1. The desktop creates its inbox key and calls `POST /v1/inboxes`.
2. The desktop shows a QR code for
   `https://inbox.aizbrain.com/#v=1&i=<inboxId>&t=<captureToken>&k=<inboxPublicKey>`.
   The fragment is never sent to the server.
3. The PWA stores the three values in IndexedDB and clears the fragment from
   the address bar.

| Situation | What happens |
| --- | --- |
| New phone | Scan the QR code again. The phone holds no other secret. |
| Lost phone | "重設配對" rotates the capture token; the old phone gets `401`. |
| Reinstalled computer or lost inbox key | Pair again, which creates a new inbox. Items sealed to the old key cannot be opened by anyone and expire with the old inbox. |
| Stop using it | "停用" deletes the inbox and every pending item. |

## HTTP API

Desktop requests carry the device signature headers from
`packages/brain-core/src/signing.ts` (`X-Brain-Device-Id` is the inbox id).
The relay accepts a timestamp within ±300 seconds and rejects a reused nonce.
Phone requests use `Authorization: Bearer <captureToken>`.

| Method and path | Caller | Result |
| --- | --- | --- |
| `POST /v1/inboxes` | desktop, signed by the key in the body | `201 {inboxId, captureToken}`. Body: `{signingPublicKey}`. |
| `POST /v1/inboxes/{id}/token` | desktop | `200 {captureToken}`; the old token stops working. |
| `DELETE /v1/inboxes/{id}` | desktop | `204`; deletes the inbox and its items. |
| `POST /v1/inboxes/{id}/items` | phone | `201` stored; `200` the same id and body were already stored; `409` the id exists with a different body. |
| `GET /v1/inboxes/{id}/items` | desktop | `200 {items: [envelope]}`, oldest first. Used after reconnecting. |
| `DELETE /v1/inboxes/{id}/items/{itemId}` | desktop | `204`, also when the item is already gone. |
| `GET /v1/inboxes/{id}/stream` | desktop | WebSocket upgrade, signed like any other request. |
| `GET /api/health` | anyone | `200` |

Errors: `400` malformed, `401` bad token or signature, `404` unknown inbox,
`413` body over 4096 bytes, `429` rate limited (`Retry-After`), `507` relay
storage full.

### WebSocket

- Server → desktop: `{"type":"item","envelope":{…}}` for every pending item
  on connect and for each new one.
- Desktop → server: `{"type":"ack","id":"<itemId>"}` after the Markdown write
  succeeded. Equivalent to the `DELETE` endpoint.
- The server sends a ping every 30 seconds so proxies keep the connection
  open. The desktop reconnects with backoff and first fetches `GET …/items`.

### Duplicates

Delivery is at least once. The phone retries with the same item id, and the
relay answers `200` for a retry. If an ack is lost the relay sends the item
again, so the desktop keeps the ids it wrote during the last 30 days and acks
a repeated id without writing it again.

## Limits and retention

| Limit | Value |
| --- | --- |
| Envelope size | 4096 bytes |
| Pending items per inbox | 200 (`429` above it) |
| Item lifetime | 14 days |
| Inbox without desktop contact | deleted after 180 days |
| Relay storage | 100 MB total (`507` above it) |
| Inbox creation | 10 per IP per hour |
| Item uploads | 60 per inbox and 120 per IP per minute |
| Desktop requests | 120 per inbox per minute |
| Open streams | 3 per inbox |

The relay logs method, route template and status. It never logs tokens,
signatures, envelopes, inbox ids or IP addresses.
