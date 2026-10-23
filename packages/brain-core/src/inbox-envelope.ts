/**
 * End-to-end encrypted envelope for the phone-to-desktop inbox relay.
 *
 * The sender derives a one-time AES-256-GCM key from an ephemeral P-256 ECDH
 * exchange with the desktop's inbox public key. The relay only ever sees the
 * envelope; the AAD binds the ciphertext to its inbox and item id so the relay
 * cannot replay it under another id. See docs/inbox-relay.md.
 */
import { z } from "zod";

export const INBOX_ENVELOPE_VERSION = 1;
export const INBOX_HKDF_INFO = "second-brain-inbox-v1";
/** UTF-8 bytes of task text; keeps every envelope under the relay's 4 KB cap. */
export const INBOX_TEXT_BYTES_LIMIT = 2400;
export const INBOX_ENVELOPE_BYTES_LIMIT = 4096;

const P256_PUBLIC_KEY_BYTES = 65;
const AES_GCM_NONCE_BYTES = 12;
const INBOX_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const ITEM_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE64_URL_PATTERN = /^[A-Za-z0-9_-]*$/;

export const INBOX_SOURCES = ["pwa", "line", "email"] as const;
export type InboxSource = (typeof INBOX_SOURCES)[number];

export interface InboxPayload {
  v: 1;
  text: string;
  createdAt: string;
  source: InboxSource;
}

export interface InboxEnvelope {
  v: 1;
  id: string;
  epk: string;
  nonce: string;
  ct: string;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

const payloadSchema = z
  .object({
    v: z.literal(1),
    text: z.string(),
    createdAt: z.string().datetime({ offset: true }),
    source: z.enum(INBOX_SOURCES),
  })
  .strict();

const envelopeSchema = z
  .object({
    v: z.literal(1),
    id: z.string().regex(ITEM_ID_PATTERN),
    epk: z.string().regex(BASE64_URL_PATTERN),
    nonce: z.string().regex(BASE64_URL_PATTERN),
    ct: z.string().regex(BASE64_URL_PATTERN),
  })
  .strict();

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!BASE64_URL_PATTERN.test(value) || value.length % 4 === 1) {
    throw new Error("Invalid base64url value");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

export function isInboxId(value: string): boolean {
  return INBOX_ID_PATTERN.test(value);
}

export function isInboxItemId(value: string): boolean {
  return ITEM_ID_PATTERN.test(value);
}

function normalizeText(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (normalized === "") throw new Error("Inbox text is empty");
  if (utf8Encoder.encode(normalized).byteLength > INBOX_TEXT_BYTES_LIMIT) {
    throw new Error("Inbox text is too long");
  }
  return normalized;
}

/** Fixed key order so the same payload always encrypts the same bytes. */
export function encodeInboxPayload(payload: InboxPayload): Uint8Array<ArrayBuffer> {
  const parsed = payloadSchema.parse(payload);
  const ordered: InboxPayload = {
    v: 1,
    text: normalizeText(parsed.text),
    createdAt: parsed.createdAt,
    source: parsed.source,
  };
  return utf8Encoder.encode(JSON.stringify(ordered));
}

export function decodeInboxPayload(bytes: Uint8Array): InboxPayload {
  const parsed = payloadSchema.parse(JSON.parse(utf8Decoder.decode(bytes)));
  return { ...parsed, v: 1, text: normalizeText(parsed.text) };
}

export function parseInboxEnvelope(value: unknown): InboxEnvelope {
  const parsed = envelopeSchema.parse(value);
  if (decodeBase64Url(parsed.epk).byteLength !== P256_PUBLIC_KEY_BYTES) {
    throw new Error("Invalid inbox ephemeral key");
  }
  if (decodeBase64Url(parsed.nonce).byteLength !== AES_GCM_NONCE_BYTES) {
    throw new Error("Invalid inbox nonce");
  }
  return { ...parsed, v: 1 };
}

/** `v1\n<inboxId>\n<itemId>` as UTF-8. */
export function inboxAssociatedData(inboxId: string, itemId: string): Uint8Array<ArrayBuffer> {
  if (!isInboxId(inboxId)) throw new Error("Invalid inbox id");
  if (!isInboxItemId(itemId)) throw new Error("Invalid inbox item id");
  return utf8Encoder.encode(`v${INBOX_ENVELOPE_VERSION}\n${inboxId}\n${itemId}`);
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBuffer> {
  const joined = new Uint8Array(left.byteLength + right.byteLength);
  joined.set(left, 0);
  joined.set(right, left.byteLength);
  return joined;
}

function decodePublicKey(value: string): Uint8Array<ArrayBuffer> {
  const bytes = decodeBase64Url(value);
  if (bytes.byteLength !== P256_PUBLIC_KEY_BYTES || bytes[0] !== 0x04) {
    throw new Error("Invalid inbox public key");
  }
  return bytes;
}

function importPublicKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, { name: "ECDH", namedCurve: "P-256" }, false, []);
}

/** Import a private key from its scalar and SEC1 public key, both base64url. */
export function importInboxPrivateKey(privateScalar: string, publicKey: string): Promise<CryptoKey> {
  const raw = decodePublicKey(publicKey);
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: privateScalar,
      x: encodeBase64Url(raw.slice(1, 33)),
      y: encodeBase64Url(raw.slice(33, 65)),
      ext: false,
    },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
}

async function deriveContentKey(
  privateKey: CryptoKey,
  peerPublicKey: Uint8Array<ArrayBuffer>,
  ephemeralPublicKey: Uint8Array<ArrayBuffer>,
  recipientPublicKey: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  const shared = await crypto.subtle.deriveBits(
    { name: "ECDH", public: await importPublicKey(peerPublicKey) },
    privateKey,
    256,
  );
  const base = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: concatBytes(ephemeralPublicKey, recipientPublicKey),
      info: utf8Encoder.encode(INBOX_HKDF_INFO),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export interface SealInboxItemInput {
  /** Desktop inbox public key, SEC1 uncompressed, base64url. */
  recipientPublicKey: string;
  inboxId: string;
  itemId: string;
  payload: InboxPayload;
}

/** Deterministic inputs; only golden-vector tests pass these. */
export interface SealInboxItemOverrides {
  ephemeralPrivateKey: CryptoKey;
  ephemeralPublicKey: string;
  nonce: Uint8Array<ArrayBuffer>;
}

export async function sealInboxItem(
  input: SealInboxItemInput,
  overrides?: SealInboxItemOverrides,
): Promise<InboxEnvelope> {
  const recipient = decodePublicKey(input.recipientPublicKey);
  const aad = inboxAssociatedData(input.inboxId, input.itemId);
  const plaintext = encodeInboxPayload(input.payload);

  let ephemeralPrivateKey: CryptoKey;
  let ephemeralPublic: Uint8Array<ArrayBuffer>;
  if (overrides) {
    ephemeralPrivateKey = overrides.ephemeralPrivateKey;
    ephemeralPublic = decodePublicKey(overrides.ephemeralPublicKey);
  } else {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    ephemeralPrivateKey = pair.privateKey;
    ephemeralPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  }
  const nonce = overrides?.nonce ?? crypto.getRandomValues(new Uint8Array(AES_GCM_NONCE_BYTES));
  if (nonce.byteLength !== AES_GCM_NONCE_BYTES) throw new Error("Invalid inbox nonce");

  const key = await deriveContentKey(ephemeralPrivateKey, recipient, ephemeralPublic, recipient);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad }, key, plaintext);
  const envelope: InboxEnvelope = {
    v: 1,
    id: input.itemId,
    epk: encodeBase64Url(ephemeralPublic),
    nonce: encodeBase64Url(nonce),
    ct: encodeBase64Url(new Uint8Array(ciphertext)),
  };
  if (utf8Encoder.encode(JSON.stringify(envelope)).byteLength > INBOX_ENVELOPE_BYTES_LIMIT) {
    throw new Error("Inbox envelope is too large");
  }
  return envelope;
}

export async function openInboxItem(
  value: unknown,
  inboxId: string,
  recipientPrivateKey: CryptoKey,
  recipientPublicKey: string,
): Promise<InboxPayload> {
  const envelope = parseInboxEnvelope(value);
  const recipient = decodePublicKey(recipientPublicKey);
  const ephemeral = decodePublicKey(envelope.epk);
  const key = await deriveContentKey(recipientPrivateKey, ephemeral, ephemeral, recipient);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: decodeBase64Url(envelope.nonce),
      additionalData: inboxAssociatedData(inboxId, envelope.id),
    },
    key,
    decodeBase64Url(envelope.ct),
  );
  return decodeInboxPayload(new Uint8Array(plaintext));
}
